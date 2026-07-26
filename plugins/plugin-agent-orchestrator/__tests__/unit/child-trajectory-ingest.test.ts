/**
 * Trace-correlation spawn stamping + child-trajectory ingest (#13775). Drives
 * the service's real ingest against a temp state dir of trajectory JSON files
 * and asserts the env stamped onto a spawn carries the parent turn's traceId.
 * Uses the injectable InMemoryTaskStore (real store, no DB) and the real
 * trajectory-context; no mock stands in for the code under test.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTrajectoryGate,
  runWithTrajectoryContext,
  TRACE_ENV,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The env-stamping suite exercises resolveTrajectoryGate/TRACE_ENV from
// @elizaos/core. In an isolated worktree the plugin resolves core's PREBUILT
// dist, which is stale until turbo rebuilds it (CI does this before plugin
// tests); guard so a stale-dist local run doesn't red. The ingest suite below
// has no such dependency and always runs.
const coreExportsPresent =
  typeof resolveTrajectoryGate === "function" && TRACE_ENV?.TRACE_ID != null;
const describeEnv = coreExportsPresent ? describe : describe.skip;

import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { InMemoryTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskSession } from "../../src/services/orchestrator-task-types.js";

let stateDir: string;
const prevStateDir = process.env.ELIZA_STATE_DIR;
const prevLogging = process.env.ELIZA_TRAJECTORY_LOGGING;
const prevDisable = process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;

function makeRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    adapter: undefined,
    databaseAdapter: undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    reportError: () => {},
  } as unknown as Parameters<typeof OrchestratorTaskService>[0];
}

async function seedTaskWithSession(
  store: InMemoryTaskStore,
  session: Partial<OrchestratorTaskSession>,
): Promise<{ taskId: string; sessionId: string }> {
  const doc = await store.createTask({ title: "t", goal: "do the thing" });
  const taskId = doc.task.id;
  const sessionId = "sess-1";
  const now = new Date().toISOString();
  await store.addSession({
    id: "row-1",
    taskId,
    sessionId,
    framework: "elizaos",
    label: "worker",
    originalTask: "do the thing",
    workdir: "/tmp/wd",
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: Date.now(),
    lastActivityAt: Date.now(),
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    spawnedAt: Date.now(),
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...session,
  });
  return { taskId, sessionId };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "orch-trace-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevLogging === undefined) delete process.env.ELIZA_TRAJECTORY_LOGGING;
  else process.env.ELIZA_TRAJECTORY_LOGGING = prevLogging;
  if (prevDisable === undefined)
    delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
  else process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = prevDisable;
});

describeEnv("buildChildTraceEnv", () => {
  it("stamps the parent turn's traceId + parent step and enables logging when the gate is on", () => {
    process.env.ELIZA_TRAJECTORY_LOGGING = "1";
    expect(resolveTrajectoryGate().enabled).toBe(true);
    const svc = new OrchestratorTaskService(makeRuntime(), {
      store: new InMemoryTaskStore(),
    });
    const env = runWithTrajectoryContext(
      { traceId: "trace-parent", trajectoryStepId: "step-7" },
      () =>
        (
          svc as unknown as {
            buildChildTraceEnv: (t: string) => Record<string, string>;
          }
        ).buildChildTraceEnv("task-xyz"),
    ) as Record<string, string>;
    expect(env[TRACE_ENV.TRACE_ID]).toBe("trace-parent");
    expect(env[TRACE_ENV.TASK_ID]).toBe("task-xyz");
    expect(env[TRACE_ENV.PARENT_STEP_ID]).toBe("step-7");
    expect(env.ELIZA_TRAJECTORY_LOGGING).toBe("1");
    expect(env.ELIZA_TRAJECTORY_DIR).toContain(
      join("child-trajectories", "task-xyz"),
    );
  });

  it("forwards an explicit ELIZA_TRAJECTORY_LOGGING=0 when the gate is off", () => {
    process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = "1";
    expect(resolveTrajectoryGate().enabled).toBe(false);
    const svc = new OrchestratorTaskService(makeRuntime(), {
      store: new InMemoryTaskStore(),
    });
    const env = (
      svc as unknown as {
        buildChildTraceEnv: (t: string) => Record<string, string>;
      }
    ).buildChildTraceEnv("task-off");
    expect(env.ELIZA_TRAJECTORY_LOGGING).toBe("0");
    expect(env.ELIZA_TRAJECTORY_DIR).toBeUndefined();
    // A traceId is still minted so the child is joinable even with the gate off.
    expect(env[TRACE_ENV.TRACE_ID]).toBeTruthy();
  });
});

describe("ingestChildTrajectories", () => {
  it("attaches child trajectory files as artifacts + appends childTrajectoryIds", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {
      traceId: "trace-parent",
      parentTrajectoryStepId: "step-7",
    });
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    // Two child trajectory files under the per-task dir, in an agentId subdir
    // exactly as the recorder writes them.
    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    writeFileSync(
      join(dir, "tj-aaa.json"),
      JSON.stringify({ traceId: "trace-parent" }),
    );
    writeFileSync(
      join(dir, "tj-bbb.json"),
      JSON.stringify({ traceId: "trace-parent" }),
    );

    const ingested = await (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories(taskId, sessionId);

    expect(ingested.sort()).toEqual(["tj-aaa", "tj-bbb"]);

    const doc = await store.getTask(taskId);
    const artifacts = doc?.artifacts ?? [];
    expect(artifacts.length).toBe(2);
    expect(artifacts.every((a) => a.artifactType === "trajectory")).toBe(true);
    const corr = artifacts[0].metadata.correlation as {
      traceId?: string;
      childTrajectoryId?: string;
    };
    expect(corr.traceId).toBe("trace-parent");
    expect(corr.childTrajectoryId).toBeTruthy();

    const updatedSession = (await store.findSession(sessionId))?.session;
    expect((updatedSession?.childTrajectoryIds ?? []).sort()).toEqual([
      "tj-aaa",
      "tj-bbb",
    ]);
  });

  it("treats a missing child-trajectory dir as an empty result, not an error", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {});
    const svc = new OrchestratorTaskService(makeRuntime(), { store });
    // No dir written — non-eliza backend / gate-off child records nothing.
    const ingested = await (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories(taskId, sessionId);
    expect(ingested).toEqual([]);
    const doc = await store.getTask(taskId);
    expect(doc?.artifacts ?? []).toEqual([]);
  });

  // #14110: the trajectory dir is per-TASK but `task_complete` fires per
  // SESSION-completion. Re-completions and respawned sessions re-scan the same
  // files; without dedupe each pass duplicates artifacts and mis-stamps
  // correlation.
  function ingest(svc: OrchestratorTaskService, t: string, s: string) {
    return (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories(t, s);
  }

  async function writeTrajectoryFile(
    taskId: string,
    name: string,
    traceId: string,
  ): Promise<void> {
    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ traceId }));
  }

  it("does not duplicate artifacts or ids when the same session re-completes", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {
      traceId: "trace-parent",
    });
    const svc = new OrchestratorTaskService(makeRuntime(), { store });
    await writeTrajectoryFile(taskId, "tj-aaa.json", "trace-parent");
    await writeTrajectoryFile(taskId, "tj-bbb.json", "trace-parent");

    const first = await ingest(svc, taskId, sessionId);
    expect(first.sort()).toEqual(["tj-aaa", "tj-bbb"]);

    // Second `task_complete` for the SAME session (follow-up prompt re-completes)
    // must re-scan and skip — REVERSION: the pre-fix code re-attached both files
    // as brand-new artifacts with fresh ids.
    const second = await ingest(svc, taskId, sessionId);
    expect(second).toEqual([]);

    const doc = await store.getTask(taskId);
    const artifacts = doc?.artifacts ?? [];
    expect(artifacts.length).toBe(2);
    // Exactly one artifact per file path — no duplicate rows.
    expect(new Set(artifacts.map((a) => a.path)).size).toBe(2);

    const updated = (await store.findSession(sessionId))?.session;
    // No duplicate ids accumulated on the session.
    expect((updated?.childTrajectoryIds ?? []).sort()).toEqual([
      "tj-aaa",
      "tj-bbb",
    ]);
  });

  it("a respawned session does not re-ingest session A's files or overwrite A's correlation", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId: sessA } = await seedTaskWithSession(store, {
      traceId: "trace-A",
      parentTrajectoryStepId: "step-A",
    });
    const svc = new OrchestratorTaskService(makeRuntime(), { store });
    await writeTrajectoryFile(taskId, "tj-from-A.json", "trace-A");

    const fromA = await ingest(svc, taskId, sessA);
    expect(fromA).toEqual(["tj-from-A"]);

    // A respawned session B on the same task ingests. Session A's file is still
    // on disk (per-task dir) — B must NOT re-attach it under B's correlation.
    const now = new Date().toISOString();
    const sessB = "sess-B";
    await store.addSession({
      id: "row-B",
      taskId,
      sessionId: sessB,
      framework: "elizaos",
      label: "worker-B",
      originalTask: "do the thing",
      workdir: "/tmp/wd",
      status: "completed",
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: Date.now(),
      lastActivityAt: Date.now(),
      idleCheckCount: 0,
      taskDelivered: true,
      lastSeenDecisionIndex: 0,
      spawnedAt: Date.now(),
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      usageState: "unavailable",
      traceId: "trace-B",
      parentTrajectoryStepId: "step-B",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    // Session B also records a genuinely-new file.
    await writeTrajectoryFile(taskId, "tj-from-B.json", "trace-B");

    const fromB = await ingest(svc, taskId, sessB);
    // Only B's own new file is ingested; A's file is skipped.
    expect(fromB).toEqual(["tj-from-B"]);

    const doc = await store.getTask(taskId);
    const artifacts = doc?.artifacts ?? [];
    expect(artifacts.length).toBe(2);

    const byId = (id: string) =>
      artifacts.find(
        (a) =>
          (a.metadata.correlation as { childTrajectoryId?: string })
            ?.childTrajectoryId === id,
      );
    // A's file keeps A's correlation (session + traceId), NOT re-stamped to B.
    const aCorr = byId("tj-from-A")?.metadata.correlation as {
      traceId?: string;
      sessionId?: string;
      parentStepId?: string;
    };
    expect(aCorr.traceId).toBe("trace-A");
    expect(aCorr.sessionId).toBe(sessA);
    expect(aCorr.parentStepId).toBe("step-A");
    // B's file carries B's correlation.
    const bCorr = byId("tj-from-B")?.metadata.correlation as {
      traceId?: string;
      sessionId?: string;
      parentStepId?: string;
    };
    expect(bCorr.traceId).toBe("trace-B");
    expect(bCorr.sessionId).toBe(sessB);
    expect(bCorr.parentStepId).toBe("step-B");
  });
});
