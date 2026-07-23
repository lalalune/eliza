/**
 * Verifies Cloud activation-goal adoption against the real LifeOps cache-backed
 * stores, including concurrency, restart readback, and resumable partial writes.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { ActivationGoalHandoffEnvelope } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { LifeOpsActivationGoalHandoffService } from "../src/lifeops/ftu-goal/handoff-service.ts";
import { createFtuGoalStateStore } from "../src/lifeops/ftu-goal/state.ts";
import { createOwnerFactStore } from "../src/lifeops/owner/fact-store.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

const ACCEPTED_GOAL = {
  activationVersion: "activation-v1",
  status: "accepted",
  response: {
    messageId: "shared-response-1",
    text: "Let's turn that into a focused launch plan.",
    createdAt: 1_784_790_000_000,
  },
  goal: {
    text: "Ship the iOS app and get the first ten customers",
    confidence: 0.94,
    model: "live-model",
    recordedAt: 1_784_790_000_001,
  },
} satisfies ActivationGoalHandoffEnvelope;

function createSharedCacheRuntimes(): {
  first: IAgentRuntime;
  restarted: IAgentRuntime;
  failNextLifecycleWrite: () => void;
} {
  const cache = new Map<string, unknown>();
  const agentId = "lifeops-handoff-agent" as UUID;
  let shouldFailLifecycleWrite = false;
  const overrides = {
    agentId,
    async getCache<T>(key: string): Promise<T | null> {
      return (cache.get(key) as T | undefined) ?? null;
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      if (shouldFailLifecycleWrite && key === "eliza:lifeops:ftu-goal:v1") {
        shouldFailLifecycleWrite = false;
        throw new Error("simulated lifecycle write outage");
      }
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
  };
  return {
    first: createMinimalRuntimeStub(overrides),
    restarted: createMinimalRuntimeStub(overrides),
    failNextLifecycleWrite: () => {
      shouldFailLifecycleWrite = true;
    },
  };
}

describe("LifeOps activation-goal handoff", () => {
  it("adopts one accepted goal exactly once under concurrency", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = await LifeOpsActivationGoalHandoffService.start(runtime);

    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        service.adoptActivationGoal(ACCEPTED_GOAL),
      ),
    );

    expect(results.filter((result) => result.adopted)).toHaveLength(1);
    expect(results.every((result) => result.verified)).toBe(true);
    expect(
      results.every((result) => result.goal === ACCEPTED_GOAL.goal?.text),
    ).toBe(true);

    const [lifecycle, facts] = await Promise.all([
      createFtuGoalStateStore(runtime).read(),
      createOwnerFactStore(runtime).read(),
    ]);
    expect(lifecycle).toMatchObject({
      status: "complete",
      goal: {
        goal: ACCEPTED_GOAL.goal?.text,
        confidence: ACCEPTED_GOAL.goal?.confidence,
        sourceMessageId: ACCEPTED_GOAL.response?.messageId,
      },
    });
    expect(facts.primaryGoal).toMatchObject({
      value: ACCEPTED_GOAL.goal?.text,
      provenance: {
        source: "agent_inferred",
      },
    });
    expect(facts.primaryGoal?.provenance.note).toContain("live-model");
  });

  it("verifies an already-adopted goal after a runtime restart", async () => {
    const runtimes = createSharedCacheRuntimes();
    const firstService = await LifeOpsActivationGoalHandoffService.start(
      runtimes.first,
    );
    expect(await firstService.adoptActivationGoal(ACCEPTED_GOAL)).toMatchObject(
      {
        adopted: true,
        verified: true,
      },
    );

    const restartedService = await LifeOpsActivationGoalHandoffService.start(
      runtimes.restarted,
    );
    expect(await restartedService.adoptActivationGoal(ACCEPTED_GOAL)).toEqual({
      adopted: false,
      verified: true,
      goal: ACCEPTED_GOAL.goal?.text,
    });
  });

  it("resumes after the owner fact persists but the lifecycle write fails", async () => {
    const runtimes = createSharedCacheRuntimes();
    const service = await LifeOpsActivationGoalHandoffService.start(
      runtimes.first,
    );
    runtimes.failNextLifecycleWrite();

    await expect(service.adoptActivationGoal(ACCEPTED_GOAL)).rejects.toThrow(
      "simulated lifecycle write outage",
    );
    expect(
      (await createOwnerFactStore(runtimes.first).read()).primaryGoal?.value,
    ).toBe(ACCEPTED_GOAL.goal?.text);
    expect((await createFtuGoalStateStore(runtimes.first).read()).status).toBe(
      "pending",
    );

    expect(await service.adoptActivationGoal(ACCEPTED_GOAL)).toMatchObject({
      adopted: true,
      verified: true,
    });
  });

  it("rejects pending, malformed, and conflicting accepted envelopes", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = await LifeOpsActivationGoalHandoffService.start(runtime);

    await expect(
      service.adoptActivationGoal({
        activationVersion: "activation-v1",
        status: "pending",
      }),
    ).rejects.toThrow("accepted, valid goal envelope");
    await expect(
      service.adoptActivationGoal({
        activationVersion: "activation-v1",
        status: "accepted",
      } as ActivationGoalHandoffEnvelope),
    ).rejects.toThrow("accepted, valid goal envelope");

    await service.adoptActivationGoal(ACCEPTED_GOAL);
    await expect(
      service.adoptActivationGoal({
        ...ACCEPTED_GOAL,
        goal: {
          ...ACCEPTED_GOAL.goal,
          text: "Replace the already-adopted goal",
        },
      }),
    ).rejects.toThrow("durable goal readback did not match");
    expect(
      (await createOwnerFactStore(runtime).read()).primaryGoal?.value,
    ).toBe(ACCEPTED_GOAL.goal?.text);
  });
});
