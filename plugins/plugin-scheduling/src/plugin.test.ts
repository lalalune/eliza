/**
 * Exercises late scheduling-plugin registration through a real AgentRuntime
 * and in-memory persistence, proving runner readiness precedes boot seeding.
 */
import {
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { schedulingPlugin } from "./plugin.js";
import { FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS } from "./scheduled-task/default-pack.js";
import {
  createInMemoryScheduledTaskStore,
  TestNoopScheduledTaskDispatcher,
} from "./scheduled-task/runner.js";
import {
  getScheduledTaskRunner,
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "./scheduled-task/runner-service.js";
import { registerDefaultTaskPack } from "./scheduled-task/seed-registry.js";
import { ScheduledTaskSeedService } from "./scheduled-task/seed-service.js";
import { createInMemoryScheduledTaskLogStore } from "./scheduled-task/state-log.js";

describe("scheduling plugin boot services", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
      await runtime.close();
    }
  });

  it("seeds the fallback pack after the runner is available on a late registration", async () => {
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "SchedulingBootIntegration" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.initialize();

    await runtime.registerPlugin(schedulingPlugin);
    await runtime.getServiceLoadPromise(ScheduledTaskSeedService.serviceType);

    expect(
      runtime.getServiceRegistrationStatus(
        ScheduledTaskRunnerService.serviceType,
      ),
    ).toBe("registered");
    expect(
      runtime.getServiceRegistrationStatus(
        ScheduledTaskSeedService.serviceType,
      ),
    ).toBe("registered");

    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const tasks = await runner.list();
    expect(tasks.map((task) => task.idempotencyKey).sort()).toEqual(
      Object.values(FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS).sort(),
    );
    expect(
      runtime
        .getRecentReportedErrors()
        .filter((entry) => entry.scope === "AgentRuntime.serviceStart"),
    ).toEqual([]);
  });

  it("rebuilds a fallback runner and seeds the consumer pack when a host registers later", async () => {
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "SchedulingLateHostIntegration" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.initialize();
    await runtime.registerPlugin(schedulingPlugin);

    const seedService = await runtime.getServiceLoadPromise(
      ScheduledTaskSeedService.serviceType,
    );
    expect(seedService).toBeInstanceOf(ScheduledTaskSeedService);
    if (!(seedService instanceof ScheduledTaskSeedService)) {
      throw new Error("Expected ScheduledTaskSeedService");
    }
    const fallbackRunner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    expect(await fallbackRunner.list()).toHaveLength(2);

    const consumerStore = createInMemoryScheduledTaskStore();
    let providerCalls = 0;
    registerScheduledTaskRunnerDeps(runtime, () => {
      providerCalls += 1;
      return {
        store: consumerStore,
        logStore: createInMemoryScheduledTaskLogStore(),
        dispatcher: TestNoopScheduledTaskDispatcher,
        ownerFacts: () => ({}),
        globalPause: { current: async () => ({ active: false }) },
        activity: { hasSignalSince: () => false },
        subjectStore: { wasUpdatedSince: () => false },
      };
    });
    await seedService.seed();
    expect(providerCalls).toBe(0);
    registerDefaultTaskPack(runtime, {
      id: "late-consumer-pack",
      tasks: [
        {
          kind: "reminder",
          promptInstructions: "consumer-backed reminder",
          trigger: { kind: "manual" },
          priority: "medium",
          respectsGlobalPause: true,
          source: "first_run",
          createdBy: runtime.agentId,
          ownerVisible: true,
          idempotencyKey: "consumer:late-host",
        },
      ],
    });
    await seedService.seed();

    const consumerRunner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    expect(consumerRunner).not.toBe(fallbackRunner);
    expect(providerCalls).toBe(1);
    expect(
      (await consumerRunner.list()).map((task) => task.idempotencyKey),
    ).toEqual(["consumer:late-host"]);
  });

  it("uses an already-registered host and consumer pack on initial service start", async () => {
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "SchedulingEarlyHostIntegration" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.initialize();

    const consumerStore = createInMemoryScheduledTaskStore();
    registerScheduledTaskRunnerDeps(runtime, () => ({
      store: consumerStore,
      logStore: createInMemoryScheduledTaskLogStore(),
      dispatcher: TestNoopScheduledTaskDispatcher,
      ownerFacts: () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
    }));
    registerDefaultTaskPack(runtime, {
      id: "early-consumer-pack",
      tasks: [
        {
          kind: "reminder",
          promptInstructions: "early consumer reminder",
          trigger: { kind: "manual" },
          priority: "medium",
          respectsGlobalPause: true,
          source: "first_run",
          createdBy: runtime.agentId,
          ownerVisible: true,
          idempotencyKey: "consumer:early-host",
        },
      ],
    });

    await runtime.registerPlugin(schedulingPlugin);
    await runtime.getServiceLoadPromise(ScheduledTaskSeedService.serviceType);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    expect((await runner.list()).map((task) => task.idempotencyKey)).toEqual([
      "consumer:early-host",
    ]);
  });

  it("starts after pre-init host registration without waiting on itself", async () => {
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "SchedulingPreInitHostIntegration" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.registerPlugin(schedulingPlugin);

    registerScheduledTaskRunnerDeps(runtime, () => ({
      store: createInMemoryScheduledTaskStore(),
      logStore: createInMemoryScheduledTaskLogStore(),
      dispatcher: TestNoopScheduledTaskDispatcher,
      ownerFacts: () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
    }));
    registerDefaultTaskPack(runtime, {
      id: "pre-init-consumer-pack",
      tasks: [
        {
          kind: "reminder",
          promptInstructions: "pre-init consumer reminder",
          trigger: { kind: "manual" },
          priority: "medium",
          respectsGlobalPause: true,
          source: "first_run",
          createdBy: runtime.agentId,
          ownerVisible: true,
          idempotencyKey: "consumer:pre-init-host",
        },
      ],
    });

    await runtime.initialize();
    await runtime.getServiceLoadPromise(ScheduledTaskSeedService.serviceType);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    expect((await runner.list()).map((task) => task.idempotencyKey)).toEqual([
      "consumer:pre-init-host",
    ]);
  });
});
