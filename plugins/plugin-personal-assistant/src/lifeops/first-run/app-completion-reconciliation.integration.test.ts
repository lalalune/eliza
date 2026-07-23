/**
 * Proves app-completion and FTU goal transitions against the real PGlite
 * cache, including persistence across runtime restart and concurrent writers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../../packages/test/helpers/real-runtime.ts";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.ts";
import { resetElizaConfigStubState } from "../../../test/stubs/agent.ts";
import { createFtuGoalStateStore } from "../ftu-goal/state.ts";
import { createOwnerFactStore } from "../owner/fact-store.ts";
import { createFirstRunStateStore } from "./state.ts";

describe("activation lifecycle persistence — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;
  let pgliteDir: string | null = null;
  const previousCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
    if (pgliteDir && fs.existsSync(pgliteDir)) {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    }
    pgliteDir = null;
    resetElizaConfigStubState();
    if (previousCloudProvisioned === undefined) {
      delete process.env.ELIZA_CLOUD_PROVISIONED;
    } else {
      process.env.ELIZA_CLOUD_PROVISIONED = previousCloudProvisioned;
    }
  });

  async function boot(): Promise<AgentRuntime> {
    if (!pgliteDir) {
      pgliteDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "lifeops-activation-pglite-"),
      );
    }
    runtimeResult = await createRealTestRuntime({
      characterName: "LifeOpsActivationPersistence",
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    return runtimeResult.runtime;
  }

  async function restart(): Promise<AgentRuntime> {
    if (!runtimeResult) {
      throw new Error("runtime must be booted before restart");
    }
    await runtimeResult.cleanup();
    runtimeResult = null;
    return await boot();
  }

  it("keeps one app_handoff completion across concurrency and restart", async () => {
    let runtime = await boot();
    await Promise.all(
      Array.from({ length: 24 }, () =>
        createFirstRunStateStore(runtime).adoptAppCompletion(),
      ),
    );

    runtime = await restart();
    const persisted = await createFirstRunStateStore(runtime).read();
    expect(persisted).toMatchObject({
      status: "complete",
      path: "app_handoff",
      completionCount: 1,
    });

    await Promise.all(
      Array.from({ length: 12 }, () =>
        createFirstRunStateStore(runtime).adoptAppCompletion(),
      ),
    );
    expect(
      (await createFirstRunStateStore(runtime).read()).completionCount,
    ).toBe(1);
  });

  it("commits one goal and matching owner fact under concurrent writers", async () => {
    const runtime = await boot();
    const goals = [
      "Ship the iOS app",
      "Stay on top of family follow-ups",
      "Train for a marathon",
    ];

    const completions = await Promise.all(
      goals.map((goal, index) => {
        const discoveredAt = new Date(Date.now() + index).toISOString();
        return createFtuGoalStateStore(runtime).completeIfPending(
          {
            goal,
            confidence: 0.9,
            discoveredAt,
            sourceMessageId: `message-${index}`,
          },
          async () => {
            await createOwnerFactStore(runtime).update(
              { primaryGoal: goal },
              {
                source: "agent_inferred",
                recordedAt: discoveredAt,
                note: `concurrent integration writer ${index}`,
              },
            );
          },
        );
      }),
    );

    expect(
      completions.filter((completion) => completion.didComplete),
    ).toHaveLength(1);
    const record = await createFtuGoalStateStore(runtime).read();
    const facts = await createOwnerFactStore(runtime).read();
    expect(record.status).toBe("complete");
    expect(record.goal?.goal).toBe(facts.primaryGoal?.value);
    expect(goals).toContain(record.goal?.goal);
  });

  it("awaits managed Cloud app-completion reconciliation during real plugin init", async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    runtimeResult = await createLifeOpsTestRuntime({
      characterName: "LifeOpsCloudActivationInit",
    });
    const runtime = runtimeResult.runtime;

    const deadline = Date.now() + 5_000;
    let record = await createFirstRunStateStore(runtime).read();
    while (record.status !== "complete" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await createFirstRunStateStore(runtime).read();
    }
    expect(record).toMatchObject({
      status: "complete",
      path: "app_handoff",
      completionCount: 1,
    });
  });
});
