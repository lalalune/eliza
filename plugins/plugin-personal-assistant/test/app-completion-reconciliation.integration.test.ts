/**
 * Boots the production personal-assistant plugin on a real PGlite runtime and
 * reconciles managed Cloud setup through the real agent config loader.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasPersistedFirstRunState,
  isAppFirstRunComplete,
  loadElizaConfig,
} from "@elizaos/agent";
import { afterEach, describe, expect, it } from "vitest";
import type { RealTestRuntimeResult } from "../../../packages/test/helpers/real-runtime.ts";
import { createFirstRunStateStore } from "../src/lifeops/first-run/state.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

const ISOLATED_ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
] as const;

describe("managed Cloud app-completion reconciliation", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;
  let stateDir: string | null = null;
  let savedEnv: Map<string, string | undefined> | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;

    if (savedEnv) {
      for (const key of ISOLATED_ENV_KEYS) {
        const value = savedEnv.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      savedEnv = null;
    }

    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
  });

  it("adopts app_handoff from only the deployment marker and an empty real config", async () => {
    savedEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "lifeops-cloud-first-run-"),
    );
    const configPath = path.join(stateDir, "eliza.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ logging: { level: "error" } }),
      "utf8",
    );

    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.STEWARD_AGENT_TOKEN;
    delete process.env.ELIZA_API_TOKEN;

    const config = loadElizaConfig();
    expect(hasPersistedFirstRunState(config)).toBe(false);
    expect(isAppFirstRunComplete(config)).toBe(true);

    runtimeResult = await createLifeOpsTestRuntime({
      characterName: "ManagedCloudFirstRunReconciliation",
    });
    const store = createFirstRunStateStore(runtimeResult.runtime);
    const deadline = Date.now() + 5_000;
    let record = await store.read();
    while (record.status !== "complete" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await store.read();
    }

    expect(record).toMatchObject({
      status: "complete",
      path: "app_handoff",
      completionCount: 1,
    });
  });
});
