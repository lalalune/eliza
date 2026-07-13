/**
 * Boot-time default-pack seeding sequenced behind the scheduled-task runner.
 * Keeping seeding in its own service makes runner readiness a structural
 * dependency instead of a microtask race with plugin service registration.
 */
import { type IAgentRuntime, Service } from "@elizaos/core";
import { buildFallbackDefaultPack } from "./default-pack.js";
import {
  getScheduledTaskRunner,
  getScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "./runner-service.js";
import {
  getDefaultTaskPacks,
  registerDefaultTaskPack,
  seedRegisteredTaskPacks,
} from "./seed-registry.js";

export const SCHEDULED_TASK_SEED_SERVICE_TYPE =
  "lifeops_scheduled_task_seed" as const;

export class ScheduledTaskSeedService extends Service {
  static override readonly serviceType = SCHEDULED_TASK_SEED_SERVICE_TYPE;

  override capabilityDescription =
    "Seeds registered default scheduled-task packs after the runner service is ready.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ScheduledTaskSeedService> {
    await runtime.getServiceLoadPromise(ScheduledTaskRunnerService.serviceType);

    const hasConsumerHost = getScheduledTaskRunnerDeps(runtime) !== null;
    const alreadyRegistered = getDefaultTaskPacks(runtime).length > 0;
    if (!hasConsumerHost && !alreadyRegistered) {
      registerDefaultTaskPack(
        runtime,
        buildFallbackDefaultPack({ agentId: runtime.agentId }),
      );
    }

    const service = new ScheduledTaskSeedService(runtime);
    await service.seed();
    return service;
  }

  /** Materialize every currently registered pack through the active runner. */
  async seed(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error("ScheduledTaskSeedService has no bound runtime");
    }
    const packs = getDefaultTaskPacks(runtime);
    const hasConsumerPack = packs.some((pack) => pack.fallback !== true);
    if (getScheduledTaskRunnerDeps(runtime) !== null && !hasConsumerPack) {
      return;
    }
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    await seedRegisteredTaskPacks(runtime, runner);
  }

  override async stop(): Promise<void> {}
}
