/**
 * Fail-closed contract tests for the live onboarding evidence wrapper.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLiveProofPreconditions,
  buildLiveScenarioEnv,
  exportScenarioModelCallEvidence,
  LIVE_ONBOARDING_SCENARIO_ID,
  validateLiveProofEvidence,
} from "./live-onboarding-activation-proof.mjs";

const tempDirs = [];

function createEvidenceFixture({ providerName = "openai" } = {}) {
  const outputDir = mkdtempSync(
    path.join(os.tmpdir(), "eliza-live-onboarding-proof-"),
  );
  tempDirs.push(outputDir);
  const runDir = path.join(outputDir, "run");
  const report = path.join(outputDir, "report.json");
  const nativeJsonl = path.join(outputDir, "native.jsonl");
  const modelCalls = path.join(outputDir, "model-calls.json");
  mkdirSync(path.join(runDir, "viewer"), { recursive: true });
  mkdirSync(path.join(runDir, "trajectories", "agent"), { recursive: true });
  writeFileSync(path.join(runDir, "viewer", "index.html"), "<html></html>");
  writeFileSync(path.join(runDir, "viewer", "data.js"), "window.DATA={};");
  writeFileSync(
    report,
    JSON.stringify({
      providerName,
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      scenarios: [
        {
          id: LIVE_ONBOARDING_SCENARIO_ID,
          status: "passed",
          finalChecks: [{ status: "passed" }, { status: "passed" }],
        },
      ],
    }),
  );
  const problem = "shipping the iOS version of my app";
  const evaluator = "Decide whether this turn reveals the owner's PRIMARY goal";
  writeFileSync(
    path.join(runDir, "trajectories", "agent", "trajectory.json"),
    JSON.stringify({ stages: [{ prompt: `${problem}\n${evaluator}` }] }),
  );
  writeFileSync(
    nativeJsonl,
    `${JSON.stringify({
      scenarioId: LIVE_ONBOARDING_SCENARIO_ID,
      provider: "openai",
      model: "gpt-live",
      request: { prompt: `${problem}\n${evaluator}` },
      response: { text: '{"goalFound":true,"goal":"Ship the iOS app"}' },
    })}\n`,
  );
  writeFileSync(
    modelCalls,
    JSON.stringify({
      scenarioId: LIVE_ONBOARDING_SCENARIO_ID,
      modelCalls: [
        {
          provider: "openai",
          model: "gpt-live",
          purpose: "evaluation",
          userPrompt: `${problem}\n${evaluator}`,
          response: '{"goalFound":true,"goal":"Ship the iOS app"}',
        },
      ],
    }),
  );
  return { outputDir, runDir, report, nativeJsonl, modelCalls };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("live onboarding proof preconditions", () => {
  it("accepts a live credential without exposing its value", () => {
    expect(
      assertLiveProofPreconditions({ CEREBRAS_API_KEY: "secret" }),
    ).toEqual({
      credentialKeys: ["CEREBRAS_API_KEY"],
      cliProvider: null,
      requestedProvider: null,
    });
  });

  it("requires the credential matching an explicitly selected provider", () => {
    expect(() =>
      assertLiveProofPreconditions({
        OPENAI_API_KEY: "openai-secret",
        LIVE_ONBOARDING_LLM_PROVIDER: "anthropic",
      }),
    ).toThrow("requires one of ANTHROPIC_API_KEY");
  });

  it("rejects deterministic proxy mode even when a live key exists", () => {
    expect(() =>
      assertLiveProofPreconditions({
        OPENAI_API_KEY: "secret",
        SCENARIO_USE_LLM_PROXY: "1",
      }),
    ).toThrow("requires a live provider");
  });

  it("rejects a keyless invocation instead of skipping", () => {
    expect(() => assertLiveProofPreconditions({})).toThrow(
      "No live model provider is configured",
    );
  });
});

describe("live onboarding proof provider isolation", () => {
  it("isolates an Anthropic run from unrelated OpenAI and Cerebras settings", () => {
    const childEnv = buildLiveScenarioEnv(
      {
        ANTHROPIC_API_KEY: "anthropic-secret",
        CEREBRAS_API_KEY: "cerebras-secret",
        OPENAI_API_KEY: "openai-secret",
        OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
        OPENAI_LARGE_MODEL: "gpt-oss-120b",
      },
      "anthropic",
    );
    expect(childEnv).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic-secret",
      SCENARIO_USE_LLM_PROXY: "0",
      ELIZA_SCENARIO_USE_LLM_PROXY: "0",
    });
    expect(childEnv.OPENAI_API_KEY).toBe("");
    expect(childEnv.CEREBRAS_API_KEY).toBe("");
  });

  it("pairs an explicit Cerebras run with its key, endpoint, and model", () => {
    const childEnv = buildLiveScenarioEnv(
      {
        CEREBRAS_API_KEY: "cerebras-secret",
        OPENAI_API_KEY: "openai-secret",
        CEREBRAS_MODEL: "gpt-oss-live",
      },
      "cerebras",
    );
    expect(childEnv).toMatchObject({
      CEREBRAS_API_KEY: "cerebras-secret",
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      OPENAI_SMALL_MODEL: "gpt-oss-live",
      OPENAI_LARGE_MODEL: "gpt-oss-live",
      ELIZA_PROVIDER: "cerebras",
    });
    expect(childEnv.OPENAI_API_KEY).toBe("");
  });
});

describe("live onboarding trajectory-service export", () => {
  it("exports the real stored evaluator input and output", async () => {
    const outputDir = mkdtempSync(
      path.join(os.tmpdir(), "eliza-live-onboarding-db-"),
    );
    tempDirs.push(outputDir);
    const pgliteDir = path.join(outputDir, "pglite");
    const outputPath = path.join(outputDir, "model-calls.json");
    const database = new PGlite(pgliteDir);
    await database.exec(`
      CREATE TABLE trajectories (
        id TEXT PRIMARY KEY,
        scenario_id TEXT,
        start_time BIGINT NOT NULL,
        steps_json JSONB NOT NULL
      )
    `);
    await database.query(
      "INSERT INTO trajectories (id, scenario_id, start_time, steps_json) VALUES ($1, $2, $3, $4)",
      [
        "trajectory-1",
        LIVE_ONBOARDING_SCENARIO_ID,
        1,
        JSON.stringify([
          {
            stepId: "step-1",
            llmCalls: [
              {
                callId: "call-1",
                purpose: "evaluation",
                userPrompt:
                  "shipping the iOS version of my app\nDecide whether this turn reveals the owner's PRIMARY goal",
                response:
                  '{"goalFound":true,"goal":"Ship the iOS app","confidence":0.95}',
              },
            ],
          },
        ]),
      ],
    );
    await database.close();

    const calls = await exportScenarioModelCallEvidence({
      pgliteDir,
      outputPath,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      scenarioId: LIVE_ONBOARDING_SCENARIO_ID,
      modelCalls: [
        {
          trajectoryId: "trajectory-1",
          stepId: "step-1",
          callId: "call-1",
          purpose: "evaluation",
        },
      ],
    });
  });
});

describe("live onboarding proof evidence validation", () => {
  it("accepts a passed live report with raw and native evaluator evidence", () => {
    const verdict = validateLiveProofEvidence(createEvidenceFixture());
    expect(verdict).toMatchObject({
      passed: true,
      providerName: "openai",
      scenarioId: LIVE_ONBOARDING_SCENARIO_ID,
      nativeRows: 1,
      evaluatorBoundaryRows: 1,
    });
  });

  it("rejects a deterministic report even when its assertions claim pass", () => {
    expect(() =>
      validateLiveProofEvidence(
        createEvidenceFixture({ providerName: "deterministic-llm-proxy" }),
      ),
    ).toThrow("report provider must be live");
  });
});
