/** Unit tests for EmbeddedWorkflowService CRUD and persistence against a real PGlite-backed Drizzle store. */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime } from '@elizaos/core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { resolveSmithersDbPath } from '../../src/services/smithers-runtime';
import { WorkflowService } from '../../src/services/workflow-service';
import type { WorkflowDefinition } from '../../src/types/index';

function runtime(
  settings: Record<string, unknown> = {},
  services: Record<string, unknown> = {},
  db?: unknown
) {
  const mockRuntime = {
    agentId: 'agent-test',
    character: { settings: {} },
    db,
    getSetting: (key: string) => settings[key] ?? null,
    getService: (type: string) => services[type] ?? null,
  } satisfies Partial<IAgentRuntime> & { db?: unknown };

  return mockRuntime as IAgentRuntime;
}

async function persistentRuntime(
  settings: Record<string, unknown> = {},
  services: Record<string, unknown> = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-workflow-service-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  return {
    runtime: runtime({ WORKFLOW_SEED_DEFAULTS: false, ...settings }, services, db),
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A seeding harness with the pieces the default-workflow seed needs: a
 * persistent PGlite DB that survives service restarts, an in-memory task queue
 * (so `armSchedules` has `createTask`/`getTasks`/`deleteTask`), and a
 * persistent in-memory cache backing `getCache`/`setCache` so the once-per
 * install seed marker survives a restart. `restart()` starts a fresh service
 * against the SAME db + cache, simulating a process reboot.
 */
async function seedingHarness(settings: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-workflow-seed-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const tasks: Array<Record<string, unknown>> = [];
  const cache = new Map<string, unknown>();
  const reports: Array<{ scope: string; error: unknown; context?: Record<string, unknown> }> = [];
  const settingsMap: Record<string, unknown> = {
    WORKFLOW_SEED_DEFAULTS: true,
    ...settings,
  };
  // When true, the next getCache/setCache call throws to simulate a transient
  // cache outage (used to prove the fail-closed no-zombie-re-seed guarantee).
  const control = {
    failNextCacheRead: false,
    failCacheWrite: false,
    cacheWriteReturnsFalse: false,
    failPriorDeletionCheck: false,
    failTaskCreateAt: null as number | null,
    failTaskDeleteAt: null as number | null,
  };
  const taskOps = { creates: 0, deletes: 0 };
  const runtimeDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'select') return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const builder = Reflect.apply(target.select, target, args);
        return new Proxy(builder, {
          get(selectTarget, selectProp, selectReceiver) {
            if (selectProp !== 'from') {
              return Reflect.get(selectTarget, selectProp, selectReceiver);
            }
            return (table: unknown) => {
              if (control.failPriorDeletionCheck && table === dbSchema.workflowRevisions) {
                throw new Error('workflow revision query unavailable');
              }
              return Reflect.apply(selectTarget.from, selectTarget, [table]);
            };
          },
        });
      };
    },
  });
  let taskSeq = 0;
  const buildRuntime = () =>
    ({
      agentId: 'agent-test',
      character: { settings: {} },
      db: runtimeDb,
      getSetting: (key: string) => settingsMap[key] ?? null,
      getService: () => null,
      reportError: (scope: string, error: unknown, context?: Record<string, unknown>) => {
        reports.push({ scope, error, context });
      },
      createTask: async (task: Record<string, unknown>) => {
        taskOps.creates += 1;
        if (control.failTaskCreateAt === taskOps.creates) {
          control.failTaskCreateAt = null;
          throw new Error('injected task create failure');
        }
        taskSeq += 1;
        const stored = { id: `task-${taskSeq}`, ...task };
        tasks.push(stored);
        return stored.id;
      },
      getTasks: async () => tasks,
      deleteTask: async (id: string) => {
        taskOps.deletes += 1;
        if (control.failTaskDeleteAt === taskOps.deletes) {
          control.failTaskDeleteAt = null;
          throw new Error('injected task delete failure');
        }
        const index = tasks.findIndex((task) => task.id === id);
        if (index >= 0) tasks.splice(index, 1);
      },
      getCache: async <T>(key: string): Promise<T | undefined> => {
        if (control.failNextCacheRead) {
          throw new Error('cache unavailable');
        }
        return cache.has(key) ? (cache.get(key) as T) : undefined;
      },
      setCache: async <T>(key: string, value: T): Promise<boolean> => {
        if (control.failCacheWrite) {
          throw new Error('cache write unavailable');
        }
        // Simulate a cache backend that reports a non-persisted write via its
        // boolean return rather than by throwing.
        if (control.cacheWriteReturnsFalse) {
          return false;
        }
        cache.set(key, value);
        return true;
      },
    }) as unknown as IAgentRuntime;

  return {
    tasks,
    cache,
    control,
    taskOps,
    reports,
    setSetting(key: string, value: unknown) {
      settingsMap[key] = value;
    },
    async start() {
      return EmbeddedWorkflowService.start(buildRuntime());
    },
    async listDefaultRows() {
      return db
        .select({ id: dbSchema.embeddedWorkflows.id })
        .from(dbSchema.embeddedWorkflows)
        .where(eq(dbSchema.embeddedWorkflows.id, DEFAULT_WORKFLOW_ID));
    },
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const DEFAULT_WORKFLOW_ID = 'system-device-health-check';
const SEED_MARKER_KEY = 'eliza:workflow:seeded-defaults:v1';

function scheduledDefinition(id: string, intervalsInSeconds: number[]): WorkflowDefinition {
  const nodes = intervalsInSeconds.map((seconds, index) => ({
    id: `schedule-${index + 1}`,
    name: `Schedule ${index + 1}`,
    type: 'workflows-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, index * 100] as [number, number],
    parameters: {
      rule: { interval: [{ field: 'seconds', secondsInterval: seconds }] },
    },
  }));
  return {
    id,
    name: `Scheduled ${id}`,
    nodes,
    connections: {},
  };
}

function manualDefinition(id: string): WorkflowDefinition {
  return {
    id,
    name: `Manual ${id}`,
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'workflows-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };
}

describe('EmbeddedWorkflowService', () => {
  test('rejects workflows with unregistered nodes before activation', async () => {
    const service = await EmbeddedWorkflowService.start(runtime());

    await expect(
      service.createWorkflow({
        name: 'Unsupported',
        nodes: [
          {
            id: 'unknown',
            name: 'Unknown',
            type: 'workflows-nodes-base.unknown',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
      })
    ).rejects.toThrow('Embedded workflow runtime does not support node');
  });

  test('WorkflowService uses the embedded backend without external runtime settings', async () => {
    const harness = await persistentRuntime({ WORKFLOW_BACKEND: 'embedded' });
    const embedded = await EmbeddedWorkflowService.start(harness.runtime);
    const serviceRuntime = runtime(
      { WORKFLOW_BACKEND: 'embedded' },
      { embedded_workflow_service: embedded },
      harness.runtime.db
    );
    serviceRuntime.getServiceLoadPromise = async (serviceType) => {
      if (serviceType === EmbeddedWorkflowService.serviceType) return embedded;
      throw new Error(`Unexpected service load request: ${String(serviceType)}`);
    };
    const service = await WorkflowService.start(serviceRuntime);

    const workflows = await service.listWorkflows();
    expect(workflows).toEqual([]);

    await service.stop();
    await embedded.stop();
    await harness.close();
  }, 60_000);

  test('stop waits for admitted reads and rejects them before they can create recovery work', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    const workflow = await service.createWorkflow({
      name: 'Admission barrier',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    });
    const internal = service as unknown as {
      getStoredWorkflow: (id: string) => Promise<unknown>;
    };
    const getStoredWorkflow = internal.getStoredWorkflow.bind(service);
    let enterRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const readEntered = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    internal.getStoredWorkflow = async (id) => {
      enterRead?.();
      await readReleased;
      return getStoredWorkflow(id);
    };

    const runResult = service.executeWorkflow(workflow.id).then(
      (execution) => ({ execution }),
      (error: unknown) => ({ error })
    );
    await readEntered;
    let stopFinished = false;
    const stopResult = service.stop().then(() => {
      stopFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(stopFinished).toBe(false);

    releaseRead?.();
    await stopResult;
    const result = await runResult;
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('stopped workflow admission unexpectedly executed');
    expect(result.error).toMatchObject({ code: 'WORKFLOW_SERVICE_STOPPED' });
    expect((await service.listExecutions({ workflowId: workflow.id })).data).toHaveLength(0);

    await harness.close();
  }, 60_000);

  test('stop surfaces a failed durable lease handoff instead of claiming clean shutdown', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    const workflow = await service.createWorkflow({
      name: 'Failed shutdown handoff',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'wait',
          name: 'Wait',
          type: 'workflows-nodes-base.wait',
          typeVersion: 1.1,
          position: [200, 0],
          parameters: { amount: 60, unit: 'seconds' },
        },
      ],
      connections: {
        'Manual Trigger': { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
      },
    });
    const smithersDbPath = resolveSmithersDbPath(harness.runtime.agentId, workflow.id);
    const runResult = service.executeWorkflow(workflow.id).then(
      (execution) => ({ execution }),
      (error: unknown) => ({ error })
    );

    const deadline = Date.now() + 15_000;
    while ((await service.listExecutions({ workflowId: workflow.id })).data.length === 0) {
      if (Date.now() >= deadline) throw new Error('workflow pending row was not persisted');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const internal = service as unknown as {
      deferOwnedExecutionRecovery: (executionId: string, delayMs: number) => Promise<void>;
    };
    internal.deferOwnedExecutionRecovery = async () => {
      throw new Error('database lease update failed');
    };

    await expect(service.stop()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          code: 'WORKFLOW_SHUTDOWN_LEASE_RELEASE_FAILED',
        }),
      ],
    });
    const result = await runResult;
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('workflow unexpectedly completed during stop');
    expect(result.error).toMatchObject({ code: 'WORKFLOW_SHUTDOWN_LEASE_RELEASE_FAILED' });

    await harness.close();
    await Promise.all([
      rm(smithersDbPath, { force: true }),
      rm(`${smithersDbPath}-wal`, { force: true }),
      rm(`${smithersDbPath}-shm`, { force: true }),
    ]);
  }, 60_000);

  test('seeds and runs the no-LLM device health check workflow by default', async () => {
    const tasks: Array<Record<string, unknown>> = [];
    const harness = await persistentRuntime({ WORKFLOW_SEED_DEFAULTS: true });
    const runtimeWithTasks = {
      ...harness.runtime,
      agentId: 'agent-test',
      createTask: async (task: Record<string, unknown>) => {
        tasks.push({ id: `task-${tasks.length + 1}`, ...task });
      },
      getTasks: async () => tasks,
      deleteTask: async (id: string) => {
        const index = tasks.findIndex((task) => task.id === id);
        if (index >= 0) tasks.splice(index, 1);
      },
    } as unknown as IAgentRuntime;

    const service = await EmbeddedWorkflowService.start(runtimeWithTasks);
    try {
      const workflows = await service.listWorkflows();
      const healthCheck = workflows.data.find(
        (workflow) => workflow.id === 'system-device-health-check'
      );
      expect(healthCheck?.active).toBe(true);
      expect(healthCheck?.nodes.map((node) => node.type)).toContain(
        'workflows-nodes-base.deviceStatus'
      );
      expect(tasks).toHaveLength(1);
      expect((tasks[0].metadata as { workflowId?: string }).workflowId).toBe(
        'system-device-health-check'
      );

      const executions = await service.listExecutions({
        workflowId: 'system-device-health-check',
        limit: 1,
      });
      expect(executions.data).toHaveLength(1);
      expect(executions.data[0].status).toBe('success');
      const item =
        executions.data[0].data?.resultData?.runData?.['Device Status']?.[0]?.data?.main?.[0]?.[0]
          ?.json;
      expect(item?.memory).toMatchObject({
        totalBytes: expect.any(Number),
        freeBytes: expect.any(Number),
      });
      expect(item?.disk).toMatchObject({
        mount: '/',
        availableBytes: expect.any(Number),
      });
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('seeds exactly one default workflow on first run and records the marker', async () => {
    const harness = await seedingHarness();
    const service = await harness.start();
    try {
      const workflows = await service.listWorkflows();
      const defaults = workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID);
      // Exactly one default, and it is the only workflow present on a fresh install.
      expect(defaults).toHaveLength(1);
      expect(workflows.data).toHaveLength(1);
      expect(defaults[0].active).toBe(true);
      // Routed through the ONE scheduler: a single TRIGGER_DISPATCH core Task.
      expect(harness.tasks).toHaveLength(1);
      expect((harness.tasks[0].metadata as { workflowId?: string }).workflowId).toBe(
        DEFAULT_WORKFLOW_ID
      );
      // Once-per-install marker was recorded.
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
        seededAt: expect.any(String),
      });
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('is idempotent across restarts — never re-seeds a second default', async () => {
    const harness = await seedingHarness();
    const first = await harness.start();
    await first.stop();

    // Reboot against the same db + cache. The marker + existing row must both
    // suppress a second seed.
    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(1);
      expect(workflows.data).toHaveLength(1);
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('preserves an unchanged schedule task identity, deadline, and idempotency across restart', async () => {
    const harness = await seedingHarness();
    const first = await harness.start();
    const snapshot = structuredClone(harness.tasks);
    const operationsBeforeRestart = { ...harness.taskOps };
    await first.stop();

    const second = await harness.start();
    try {
      expect(harness.tasks).toEqual(snapshot);
      expect(harness.taskOps).toEqual(operationsBeforeRestart);
      expect(harness.tasks).toHaveLength(1);
      const metadata = harness.tasks[0]?.metadata as
        | { idempotencyKey?: string; trigger?: { nextRunAtMs?: number } }
        | undefined;
      expect(harness.tasks[0]?.id).toBe(snapshot[0]?.id);
      expect(metadata?.idempotencyKey).toBe(
        (snapshot[0]?.metadata as { idempotencyKey?: string } | undefined)?.idempotencyKey
      );
      expect(metadata?.trigger?.nextRunAtMs).toBe(
        (snapshot[0]?.metadata as { trigger?: { nextRunAtMs?: number } } | undefined)?.trigger
          ?.nextRunAtMs
      );
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('keeps manual workflows available on scale-to-zero Cloud agents but rejects schedule activation', async () => {
    const harness = await seedingHarness({
      WORKFLOW_SEED_DEFAULTS: false,
      ELIZA_CLOUD_PROVISIONED: '1',
      ELIZA_CLOUD_EXECUTION_TIER: 'dedicated-lazy',
    });
    const service = await harness.start();
    try {
      const scheduled = await service.createWorkflow(scheduledDefinition('lazy-schedule', [30]));
      expect(scheduled.active).toBe(false);
      await expect(service.activateWorkflow(scheduled.id)).rejects.toMatchObject({
        statusCode: 409,
        response: {
          success: false,
          code: 'workflow_requires_always_on',
          capability: 'scheduled_workflows',
          currentExecutionTier: 'dedicated-lazy',
          requiredExecutionTier: 'dedicated-always',
          upgradeRequired: true,
        },
      });
      expect((await service.getWorkflow(scheduled.id)).active).toBe(false);
      expect(harness.tasks).toHaveLength(0);

      const manual = await service.createWorkflow(manualDefinition('lazy-manual'));
      const activated = await service.activateWorkflow(manual.id);
      expect(activated.active).toBe(true);
      expect(harness.tasks).toHaveLength(0);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('rejects an active update that adds a schedule on a scale-to-zero Cloud agent', async () => {
    const harness = await seedingHarness({
      WORKFLOW_SEED_DEFAULTS: false,
      ELIZA_CLOUD_PROVISIONED: '1',
      ELIZA_CLOUD_EXECUTION_TIER: 'dedicated-lazy',
    });
    const service = await harness.start();
    try {
      const manual = await service.createWorkflow(manualDefinition('lazy-active-update'));
      await service.activateWorkflow(manual.id);

      await expect(
        service.updateWorkflow(manual.id, scheduledDefinition(manual.id, [45]))
      ).rejects.toMatchObject({
        statusCode: 409,
        response: { code: 'workflow_requires_always_on' },
      });
      const unchanged = await service.getWorkflow(manual.id);
      expect(unchanged.active).toBe(true);
      expect(unchanged.nodes.map((node) => node.type)).toEqual([
        'workflows-nodes-base.manualTrigger',
      ]);
      expect(harness.tasks).toHaveLength(0);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('rejects restoring an active scheduled revision after an agent moves to scale-to-zero', async () => {
    const harness = await seedingHarness({
      WORKFLOW_SEED_DEFAULTS: false,
      ELIZA_CLOUD_PROVISIONED: '1',
      ELIZA_CLOUD_EXECUTION_TIER: 'dedicated-always',
    });
    const service = await harness.start();
    try {
      const scheduled = await service.createWorkflow(scheduledDefinition('lazy-restore', [30]));
      await service.activateWorkflow(scheduled.id);
      await service.updateWorkflow(scheduled.id, scheduledDefinition(scheduled.id, [45]));
      const activeRevision = (await service.listWorkflowRevisions(scheduled.id)).data.find(
        (revision) => revision.active && revision.operation === 'update'
      );
      if (!activeRevision) throw new Error('Expected an active scheduled revision');
      await service.deactivateWorkflow(scheduled.id);
      harness.setSetting('ELIZA_CLOUD_EXECUTION_TIER', 'dedicated-lazy');

      await expect(
        service.restoreWorkflowRevision(scheduled.id, activeRevision.versionId)
      ).rejects.toMatchObject({
        statusCode: 409,
        response: { code: 'workflow_requires_always_on' },
      });
      expect((await service.getWorkflow(scheduled.id)).active).toBe(false);
      expect(harness.tasks).toHaveLength(0);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('does not seed a scheduled default on a scale-to-zero Cloud agent', async () => {
    const harness = await seedingHarness({
      ELIZA_CLOUD_PROVISIONED: '1',
      ELIZA_CLOUD_EXECUTION_TIER: 'dedicated-lazy',
    });
    const service = await harness.start();
    try {
      expect((await service.listWorkflows()).data).toHaveLength(0);
      expect(harness.tasks).toHaveLength(0);
      expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('deactivates legacy schedules on lazy startup while preserving active manual workflows', async () => {
    const harness = await seedingHarness({
      WORKFLOW_SEED_DEFAULTS: false,
      ELIZA_CLOUD_PROVISIONED: '1',
      ELIZA_CLOUD_EXECUTION_TIER: 'dedicated-always',
    });
    const first = await harness.start();
    const scheduled = await first.createWorkflow(scheduledDefinition('legacy-lazy-schedule', [30]));
    const manual = await first.createWorkflow(manualDefinition('legacy-lazy-manual'));
    await first.activateWorkflow(scheduled.id);
    await first.activateWorkflow(manual.id);
    expect(harness.tasks).toHaveLength(1);
    await first.stop();
    harness.setSetting('ELIZA_CLOUD_EXECUTION_TIER', 'dedicated-lazy');

    const second = await harness.start();
    try {
      expect((await second.getWorkflow(scheduled.id)).active).toBe(false);
      expect((await second.getWorkflow(manual.id)).active).toBe(true);
      expect(harness.tasks).toHaveLength(0);
      expect(harness.reports).toContainEqual(
        expect.objectContaining({
          scope: 'EmbeddedWorkflowService.rehydrateSchedules',
          context: {
            workflowId: scheduled.id,
            currentExecutionTier: 'dedicated-lazy',
          },
        })
      );
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('serializes activation and deactivation across schedule reconciliation', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    const workflow = await service.createWorkflow(
      scheduledDefinition('activate-deactivate-race', [30])
    );
    const internal = service as unknown as {
      armSchedules: (workflowId: string) => Promise<void>;
    };
    const armSchedules = internal.armSchedules.bind(service);
    let enterArm: (() => void) | undefined;
    let releaseArm: (() => void) | undefined;
    const armEntered = new Promise<void>((resolve) => {
      enterArm = resolve;
    });
    const armReleased = new Promise<void>((resolve) => {
      releaseArm = resolve;
    });
    internal.armSchedules = async (workflowId) => {
      enterArm?.();
      await armReleased;
      await armSchedules(workflowId);
    };

    try {
      const activation = service.activateWorkflow(workflow.id);
      await armEntered;
      let deactivationSettled = false;
      const deactivation = service.deactivateWorkflow(workflow.id).finally(() => {
        deactivationSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(deactivationSettled).toBe(false);
      releaseArm?.();

      const [activated, deactivated] = await Promise.all([activation, deactivation]);
      expect(activated.active).toBe(true);
      expect(deactivated.active).toBe(false);
      expect((await service.getWorkflow(workflow.id)).active).toBe(false);
      expect(harness.tasks).toHaveLength(0);
    } finally {
      releaseArm?.();
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('serializes an active update before deletion so no schedule task survives the row', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    const workflow = await service.createWorkflow(scheduledDefinition('update-delete-race', [30]));
    await service.activateWorkflow(workflow.id);
    const internal = service as unknown as {
      reconcileSchedules: (
        workflowId: string,
        definition: WorkflowDefinition | null
      ) => Promise<void>;
    };
    const reconcileSchedules = internal.reconcileSchedules.bind(service);
    let enterUpdateReconcile: (() => void) | undefined;
    let releaseUpdateReconcile: (() => void) | undefined;
    const updateReconcileEntered = new Promise<void>((resolve) => {
      enterUpdateReconcile = resolve;
    });
    const updateReconcileReleased = new Promise<void>((resolve) => {
      releaseUpdateReconcile = resolve;
    });
    internal.reconcileSchedules = async (workflowId, definition) => {
      const interval = definition?.nodes[0]?.parameters.rule as
        | { interval?: Array<{ secondsInterval?: number }> }
        | undefined;
      if (interval?.interval?.[0]?.secondsInterval === 45) {
        enterUpdateReconcile?.();
        await updateReconcileReleased;
      }
      await reconcileSchedules(workflowId, definition);
    };

    try {
      const update = service.updateWorkflow(workflow.id, scheduledDefinition(workflow.id, [45]));
      await updateReconcileEntered;
      let deletionSettled = false;
      const deletion = service.deleteWorkflow(workflow.id).finally(() => {
        deletionSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(deletionSettled).toBe(false);
      releaseUpdateReconcile?.();

      await Promise.all([update, deletion]);
      await expect(service.getWorkflow(workflow.id)).rejects.toMatchObject({ statusCode: 404 });
      expect(harness.tasks).toHaveLength(0);
    } finally {
      releaseUpdateReconcile?.();
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('rolls back activation when its schedule task cannot be created', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    const workflow = await service.createWorkflow(scheduledDefinition('activate-rollback', [30]));
    harness.control.failTaskCreateAt = harness.taskOps.creates + 1;

    try {
      await expect(service.activateWorkflow(workflow.id)).rejects.toMatchObject({
        code: 'WORKFLOW_LIFECYCLE_RECONCILE_FAILED',
        context: { workflowId: workflow.id, operation: 'activate' },
      });
      expect((await service.getWorkflow(workflow.id)).active).toBe(false);
      expect(harness.tasks).toHaveLength(0);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('restores the prior definition and task snapshot after a partial schedule update', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    const workflow = await service.createWorkflow(scheduledDefinition('update-rollback', [30]));
    await service.activateWorkflow(workflow.id);
    const previousWorkflow = await service.getWorkflow(workflow.id);
    const previousTasks = structuredClone(harness.tasks);
    // The changed first interval and added sibling both require creates. Fail
    // the second so reconciliation has already deleted/replaced part of the set.
    harness.control.failTaskCreateAt = harness.taskOps.creates + 2;

    try {
      await expect(
        service.updateWorkflow(workflow.id, scheduledDefinition(workflow.id, [45, 60]))
      ).rejects.toMatchObject({
        code: 'WORKFLOW_LIFECYCLE_RECONCILE_FAILED',
        context: { workflowId: workflow.id, operation: 'update' },
      });
      expect(await service.getWorkflow(workflow.id)).toMatchObject({
        name: previousWorkflow.name,
        active: true,
        versionId: previousWorkflow.versionId,
        nodes: previousWorkflow.nodes,
      });
      expect(harness.tasks).toEqual(previousTasks);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('restores active state and all tasks after a partial deactivation delete', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    const workflow = await service.createWorkflow(
      scheduledDefinition('deactivate-rollback', [30, 60])
    );
    await service.activateWorkflow(workflow.id);
    const previous = await service.getWorkflow(workflow.id);
    const previousTasks = structuredClone(harness.tasks);
    harness.control.failTaskDeleteAt = harness.taskOps.deletes + 2;

    try {
      await expect(service.deactivateWorkflow(workflow.id)).rejects.toMatchObject({
        code: 'WORKFLOW_LIFECYCLE_RECONCILE_FAILED',
        context: { workflowId: workflow.id, operation: 'deactivate' },
      });
      expect(await service.getWorkflow(workflow.id)).toMatchObject({
        active: true,
        versionId: previous.versionId,
      });
      expect(harness.tasks).toEqual(previousTasks);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('restores a deleted workflow row and tasks when schedule cleanup fails', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    const workflow = await service.createWorkflow(scheduledDefinition('delete-rollback', [30, 60]));
    await service.activateWorkflow(workflow.id);
    const previous = await service.getWorkflow(workflow.id);
    const previousTasks = structuredClone(harness.tasks);
    harness.control.failTaskDeleteAt = harness.taskOps.deletes + 2;

    try {
      await expect(service.deleteWorkflow(workflow.id)).rejects.toMatchObject({
        code: 'WORKFLOW_LIFECYCLE_RECONCILE_FAILED',
        context: { workflowId: workflow.id, operation: 'delete' },
      });
      expect(await service.getWorkflow(workflow.id)).toMatchObject({
        active: true,
        versionId: previous.versionId,
      });
      expect(harness.tasks).toEqual(previousTasks);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('respects a user deletion — no zombie re-seed after restart', async () => {
    const harness = await seedingHarness();
    const first = await harness.start();
    // Simulate the user deleting the seeded default.
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    let afterDelete = await first.listWorkflows();
    expect(afterDelete.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    await first.stop();

    // Reboot: the persistent marker must stop the deleted default from coming back.
    const second = await harness.start();
    try {
      afterDelete = await second.listWorkflows();
      expect(afterDelete.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('fails closed on a cache-read outage — a deleted default is not resurrected', async () => {
    const harness = await seedingHarness();
    const first = await harness.start();
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    await first.stop();

    // The marker persists in the cache, but the cache read throws on this boot.
    // We must NOT fall back to the row check and re-seed the deleted default.
    harness.control.failNextCacheRead = true;
    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('aborts seeding when the marker cannot be persisted — no orphan default', async () => {
    const harness = await seedingHarness();
    // The marker write fails on first boot: seeding must abort with NO row
    // inserted, so there is never an active default that lacks its marker.
    harness.control.failCacheWrite = true;
    const first = await harness.start();
    let workflows = await first.listWorkflows();
    expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    expect(harness.tasks).toHaveLength(0);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();
    await first.stop();

    // Cache recovers on the next boot: seeding retries cleanly and records the
    // marker exactly once.
    harness.control.failCacheWrite = false;
    const second = await harness.start();
    try {
      workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(1);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('treats a false setCache result as a failed marker write — no orphan default', async () => {
    const harness = await seedingHarness();
    // The cache reports the marker write as not-persisted (returns false).
    // Seeding must roll the row back, leaving neither row nor marker.
    harness.control.cacheWriteReturnsFalse = true;
    const first = await harness.start();
    let workflows = await first.listWorkflows();
    expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();
    await first.stop();

    // Cache recovers: seeding retries and completes exactly once.
    harness.control.cacheWriteReturnsFalse = false;
    const second = await harness.start();
    try {
      workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(1);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('backfills the seed marker for a pre-marker existing default row', async () => {
    // Simulate an install upgraded from the old row-existence-only seeding:
    // seed once while pretending the cache has no setCache (so no marker is
    // written), then reboot with a healthy cache and confirm the marker is
    // backfilled without duplicating or re-seeding the row.
    const harness = await seedingHarness();
    // First boot writes the row but the marker write reports not-persisted, so
    // the row exists with NO marker — the pre-marker upgrade state. We use the
    // false-return path and then keep the row by writing it directly is complex;
    // instead seed normally, then clear the marker to emulate the upgrade.
    const first = await harness.start();
    expect(
      (await first.listWorkflows()).data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)
    ).toHaveLength(1);
    await first.stop();
    // Emulate a pre-marker upgrade: the row exists but the marker is absent.
    harness.cache.delete(SEED_MARKER_KEY);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();

    const second = await harness.start();
    try {
      // Row is untouched (not duplicated, not re-seeded) and the marker is back.
      expect(
        (await second.listWorkflows()).data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)
      ).toHaveLength(1);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('does not seed the default into an existing non-default workflow store', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const first = await harness.start();
    await first.createWorkflow({
      id: 'user-nightly-summary',
      name: 'User nightly summary',
      active: false,
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    });
    await first.stop();
    harness.setSetting('WORKFLOW_SEED_DEFAULTS', true);

    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.map((workflow) => workflow.id)).toEqual(['user-nightly-summary']);
      expect(workflows.data.filter((workflow) => workflow.id === DEFAULT_WORKFLOW_ID)).toHaveLength(
        0
      );
      expect(harness.tasks).toHaveLength(0);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('preserves a pre-marker deletion via the delete revision on upgrade', async () => {
    // Simulate an install upgraded from a pre-marker build where the user had
    // ALREADY deleted the default: seed, delete (leaving a `delete` revision),
    // then clear the marker to emulate the pre-marker era. On reboot, neither a
    // marker nor a row exists, but the delete revision must stop a re-seed.
    const harness = await seedingHarness();
    const first = await harness.start();
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    await first.stop();
    harness.cache.delete(SEED_MARKER_KEY);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();

    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
      // The marker is backfilled so subsequent boots skip the revision query.
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('fails closed when the prior default deletion check fails', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const first = await harness.start();
    await first.createWorkflow({
      id: DEFAULT_WORKFLOW_ID,
      name: 'Pre-marker default',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    });
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    await first.stop();
    harness.setSetting('WORKFLOW_SEED_DEFAULTS', true);
    harness.control.failPriorDeletionCheck = true;

    try {
      await expect(harness.start()).rejects.toMatchObject({
        code: 'WORKFLOW_DEFAULT_SEED_DELETION_CHECK_FAILED',
        context: { workflowId: DEFAULT_WORKFLOW_ID },
      });
      expect(await harness.listDefaultRows()).toHaveLength(0);
      expect(harness.tasks).toHaveLength(0);
      expect(harness.reports).toHaveLength(1);
      expect(harness.reports[0]).toMatchObject({
        scope: 'EmbeddedWorkflowService.seedDefaultWorkflows',
        context: { workflowId: DEFAULT_WORKFLOW_ID },
      });
    } finally {
      await harness.close();
    }
  }, 90_000);

  test('WORKFLOW_SEED_DEFAULTS=false disables seeding entirely', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    try {
      const workflows = await service.listWorkflows();
      expect(workflows.data).toHaveLength(0);
      expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('runs a schedule -> HTTP Request -> Set workflow in a child process', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const script = `
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { __setWorkflowHttpTransportForTests, EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-child-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = {
        agentId: 'agent-test',
        db,
        getSetting: (key) => key === 'WORKFLOW_SEED_DEFAULTS' ? false : null,
        getService: () => null,
      };
      const service = await EmbeddedWorkflowService.start(runtime);
      try {
        __setWorkflowHttpTransportForTests(runtime, {
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
          pinnedFetchImpl: async ({ url, init }) =>
          new Response(JSON.stringify({ ok: true, url: String(url), method: init.method ?? 'GET' }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
        });
        const created = await service.createWorkflow({
          name: 'P0 smoke',
          nodes: [
            { id: 'schedule', name: 'Schedule Trigger', type: 'workflows-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: {} },
            { id: 'http', name: 'HTTP Request', type: 'workflows-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://example.test/ping', method: 'GET' } },
            { id: 'set', name: 'Set', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [400, 0], parameters: { assignments: { assignments: [{ name: 'source', value: 'embedded' }] } } },
          ],
          connections: {
            'Schedule Trigger': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
            'HTTP Request': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
          },
        });
        const execution = await service.executeWorkflow(created.id);
        const item = execution.data?.resultData?.runData?.Set?.[0]?.data?.main?.[0]?.[0]?.json;
        if (execution.status !== 'success') throw new Error('Expected successful embedded execution');
        if (item?.source !== 'embedded') throw new Error('Expected Set node to add source');
        if (item?.body?.ok !== true) throw new Error('Expected HTTP response body to be preserved');
        console.log('RESULT:' + JSON.stringify({ status: execution.status, item }));
      } finally {
        __setWorkflowHttpTransportForTests(runtime, undefined);
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;

    const proc = Bun.spawn([process.execPath, '-e', script], {
      cwd: pluginRoot,
      env: { ...process.env, WORKFLOW_DIAGNOSTICS_ENABLED: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(stderr).not.toContain('HTTP Request node requires');
    expect(exitCode).toBe(0);
  }, 60_000);

  test('executes only the reachable manual, schedule, or webhook branch for each mode', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const resultDir = await mkdtemp(join(tmpdir(), 'embedded-workflows-trigger-modes-result-'));
    const resultPath = join(resultDir, 'result.json');
    const script = `
      import { mkdtemp, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-trigger-modes-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const tasks = [];
      const runtime = {
        agentId: 'agent-trigger-modes',
        character: { settings: {} },
        db,
        getSetting: (key) => key === 'WORKFLOW_SEED_DEFAULTS' ? false : null,
        getService: () => null,
        createTask: async (task) => tasks.push(task),
        getTasks: async () => tasks,
        deleteTask: async () => {},
      };
      const service = await EmbeddedWorkflowService.start(runtime);
      try {
        const created = await service.createWorkflow({
          name: 'Mode-isolated branches',
          nodes: [
            { id: 'manual', name: 'Manual Trigger', type: 'workflows-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
            { id: 'manual-set', name: 'Manual Output', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: { assignments: { assignments: [{ name: 'branch', value: 'manual' }] } } },
            { id: 'schedule-a', name: 'Schedule Trigger A', type: 'workflows-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 200], parameters: { intervalMs: 60000 } },
            { id: 'schedule-a-set', name: 'Schedule Output A', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 200], parameters: { assignments: { assignments: [{ name: 'branch', value: 'schedule-a' }] } } },
            { id: 'schedule-b', name: 'Schedule Trigger B', type: 'workflows-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 300], parameters: { intervalMs: 60000 } },
            { id: 'schedule-b-set', name: 'Schedule Output B', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 300], parameters: { assignments: { assignments: [{ name: 'branch', value: 'schedule-b' }] } } },
            { id: 'webhook', name: 'Webhook Trigger', type: 'workflows-nodes-base.webhook', typeVersion: 2, position: [0, 500], parameters: { path: 'mode-test', httpMethod: 'POST' } },
            { id: 'webhook-set', name: 'Webhook Output', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 500], parameters: { assignments: { assignments: [{ name: 'branch', value: 'webhook' }] } } },
          ],
          connections: {
            'Manual Trigger': { main: [[{ node: 'Manual Output', type: 'main', index: 0 }]] },
            'Schedule Trigger A': { main: [[{ node: 'Schedule Output A', type: 'main', index: 0 }]] },
            'Schedule Trigger B': { main: [[{ node: 'Schedule Output B', type: 'main', index: 0 }]] },
            'Webhook Trigger': { main: [[{ node: 'Webhook Output', type: 'main', index: 0 }]] },
          },
        });

        const manual = await service.executeWorkflow(created.id, { mode: 'manual' });
        await service.activateWorkflow(created.id);
        const scheduleTasks = tasks.filter((task) => task.metadata?.scheduleNodeId);
        const scheduleA = scheduleTasks.find((task) => task.metadata.scheduleNodeId === 'schedule-a');
        const scheduleB = scheduleTasks.find((task) => task.metadata.scheduleNodeId === 'schedule-b');
        if (!scheduleA || !scheduleB) throw new Error('Expected one armed task per schedule node');
        const scheduleAFirst = await service.executeWorkflowWithDedup(created.id, {
          mode: 'trigger',
          scheduleNodeId: scheduleA.metadata.scheduleNodeId,
          idempotencyKey: scheduleA.metadata.idempotencyKey,
        });
        const scheduleADuplicate = await service.executeWorkflowWithDedup(created.id, {
          mode: 'trigger',
          scheduleNodeId: scheduleA.metadata.scheduleNodeId,
          idempotencyKey: scheduleA.metadata.idempotencyKey,
        });
        const scheduleBFirst = await service.executeWorkflowWithDedup(created.id, {
          mode: 'trigger',
          scheduleNodeId: scheduleB.metadata.scheduleNodeId,
          idempotencyKey: scheduleB.metadata.idempotencyKey,
        });
        const scheduleDebug = await service.executeWorkflow(created.id, { mode: 'trigger' });
        const staleSchedule = await service.executeWorkflow(created.id, {
          mode: 'trigger',
          scheduleNodeId: 'removed-schedule-node',
          throwOnError: false,
        });
        const webhook = await service.executeWebhook('mode-test', { requestId: 'request-1' }, 'POST');
        const keys = (execution) => Object.keys(execution.data?.resultData?.runData ?? {}).sort();
        await writeFile(process.env.WORKFLOW_MODE_RESULT_PATH, JSON.stringify({
          manual: { status: manual.status, nodes: keys(manual) },
          scheduleA: { status: scheduleAFirst.execution.status, nodes: keys(scheduleAFirst.execution), dedup: scheduleAFirst.dedup, executionId: scheduleAFirst.execution.id },
          scheduleADuplicate: { executionId: scheduleADuplicate.execution.id, dedup: scheduleADuplicate.dedup },
          scheduleB: { status: scheduleBFirst.execution.status, nodes: keys(scheduleBFirst.execution), dedup: scheduleBFirst.dedup },
          scheduleDebug: { status: scheduleDebug.status, nodes: keys(scheduleDebug) },
          staleSchedule: { status: staleSchedule.status, error: staleSchedule.data?.resultData?.error?.message },
          scheduleTasks: scheduleTasks.map((task) => ({ scheduleNodeId: task.metadata.scheduleNodeId, idempotencyKey: task.metadata.idempotencyKey })),
          webhook: { status: webhook.status, nodes: keys(webhook) },
        }));
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;

    try {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          WORKFLOW_MODE_RESULT_PATH: resultPath,
          WORKFLOW_DIAGNOSTICS_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as Record<
        string,
        | {
            status?: string;
            nodes?: string[];
            dedup?: boolean;
            executionId?: string;
            error?: string;
          }
        | Array<{ scheduleNodeId: string; idempotencyKey: string }>
      >;
      expect(result.manual).toEqual({
        status: 'success',
        nodes: ['Manual Output', 'Manual Trigger'],
      });
      expect(result.scheduleA).toMatchObject({
        status: 'success',
        nodes: ['Schedule Output A', 'Schedule Trigger A'],
        dedup: false,
      });
      expect(result.scheduleADuplicate).toMatchObject({ dedup: true });
      expect((result.scheduleADuplicate as { executionId?: string }).executionId).toBe(
        (result.scheduleA as { executionId?: string }).executionId
      );
      expect(result.scheduleB).toEqual({
        status: 'success',
        nodes: ['Schedule Output B', 'Schedule Trigger B'],
        dedup: false,
      });
      expect(result.scheduleDebug).toEqual({
        status: 'success',
        nodes: [
          'Schedule Output A',
          'Schedule Output B',
          'Schedule Trigger A',
          'Schedule Trigger B',
        ],
      });
      expect(result.staleSchedule).toMatchObject({
        status: 'error',
        error: expect.stringContaining('unknown schedule node'),
      });
      const scheduleTasks = result.scheduleTasks as Array<{
        scheduleNodeId: string;
        idempotencyKey: string;
      }>;
      expect(scheduleTasks).toHaveLength(2);
      expect(new Set(scheduleTasks.map((task) => task.idempotencyKey)).size).toBe(2);
      expect(result.webhook).toEqual({
        status: 'success',
        nodes: ['Webhook Output', 'Webhook Trigger'],
      });
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('persists workflows across embedded service restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-persist-'));
    const dataDir = join(dir, 'pglite');
    const firstClient = new PGlite({ dataDir });
    const firstDb = drizzle(firstClient, { schema: dbSchema });
    const first = await EmbeddedWorkflowService.start(
      runtime({ WORKFLOW_SEED_DEFAULTS: false }, {}, firstDb)
    );
    const created = await first.createWorkflow({
      name: 'Persistent workflow',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    });
    await first.stop();
    await firstClient.close();

    const secondClient = new PGlite({ dataDir });
    const secondDb = drizzle(secondClient, { schema: dbSchema });
    const second = await EmbeddedWorkflowService.start(
      runtime({ WORKFLOW_SEED_DEFAULTS: false }, {}, secondDb)
    );
    const loaded = await second.getWorkflow(created.id);

    expect(loaded.name).toBe('Persistent workflow');
    expect(loaded.id).toBe(created.id);

    await second.stop();
    await secondClient.close();
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  test('captures workflow revisions and restores a previous version', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const created = await service.createWorkflow({
        name: 'Revision base',
        nodes: [
          {
            id: 'manual',
            name: 'Manual Trigger',
            type: 'workflows-nodes-base.manualTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
      });
      const updated = await service.updateWorkflow(created.id, {
        ...created,
        name: 'Revision updated',
        nodes: [
          ...(created.nodes ?? []),
          {
            id: 'set',
            name: 'Set',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [200, 0],
            parameters: {
              assignments: { assignments: [{ name: 'restored', value: false }] },
            },
          },
        ],
        connections: {
          'Manual Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
        },
      });

      const beforeRestore = await service.listWorkflowRevisions(created.id);
      expect(beforeRestore.data).toHaveLength(1);
      expect(beforeRestore.data[0].name).toBe('Revision base');
      expect(beforeRestore.data[0].versionId).toBe(created.versionId);
      expect(beforeRestore.data[0].operation).toBe('update');

      const restored = await service.restoreWorkflowRevision(created.id, created.versionId);
      expect(restored.name).toBe('Revision base');
      expect(restored.nodes.map((node) => node.name)).toEqual(['Manual Trigger']);
      expect(restored.versionId).not.toBe(created.versionId);
      expect(restored.versionId).not.toBe(updated.versionId);

      const afterRestore = await service.listWorkflowRevisions(created.id);
      expect(afterRestore.data[0].name).toBe('Revision updated');
      expect(afterRestore.data[0].operation).toBe('restore');
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('runs Code node in the QuickJS sandbox', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const resultDir = await mkdtemp(join(tmpdir(), 'embedded-workflows-code-result-'));
    const resultPath = join(resultDir, 'result.json');
    const script = `
      import { mkdtemp, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-code-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = {
        agentId: 'agent-test',
        character: { settings: {} },
        db,
        getSetting: (key) => key === 'WORKFLOW_SEED_DEFAULTS' ? false : null,
        getService: () => null,
      };
      const service = await EmbeddedWorkflowService.start(runtime);
      try {
        const created = await service.createWorkflow({
          name: 'QuickJS code',
          nodes: [
            { id: 'manual', name: 'Manual Trigger', type: 'workflows-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
            { id: 'code', name: 'Code', type: 'workflows-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: 'return items.map((item) => ({ json: { ok: true, trigger: item.json.trigger } }));' } },
          ],
          connections: {
            'Manual Trigger': { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
          },
        });
        const execution = await service.executeWorkflow(created.id);
        const item = execution.data?.resultData?.runData?.Code?.[0]?.data?.main?.[0]?.[0]?.json;
        if (execution.status !== 'success') throw new Error('Expected successful Code execution');
        if (item?.ok !== true) throw new Error('Expected Code node to set ok=true');
        if (item?.trigger !== 'manual') throw new Error('Expected manual trigger data to reach Code node');
        await writeFile(process.env.WORKFLOW_CODE_RESULT_PATH, JSON.stringify({ status: execution.status, item }));
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;

    try {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          WORKFLOW_CODE_RESULT_PATH: resultPath,
          WORKFLOW_DIAGNOSTICS_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        status?: string;
        item?: { ok?: boolean; trigger?: string };
      };
      expect(result.status).toBe('success');
      expect(result.item?.ok).toBe(true);
      expect(result.item?.trigger).toBe('manual');
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('returns persisted error executions for non-throwing planning failures', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const created = await service.createWorkflow({
        name: 'Cyclic graph',
        nodes: [
          {
            id: 'set-a',
            name: 'Set A',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [0, 0],
            parameters: { assignments: { assignments: [{ name: 'a', value: true }] } },
          },
          {
            id: 'set-b',
            name: 'Set B',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [200, 0],
            parameters: { assignments: { assignments: [{ name: 'b', value: true }] } },
          },
        ],
        connections: {
          'Set A': { main: [[{ node: 'Set B', type: 'main', index: 0 }]] },
          'Set B': { main: [[{ node: 'Set A', type: 'main', index: 0 }]] },
        },
      });

      const execution = await service.executeWorkflow(created.id, { throwOnError: false });
      const persisted = await service.getExecution(execution.id);

      expect(execution.status).toBe('error');
      expect(execution.finished).toBe(true);
      expect(execution.data?.resultData?.error?.message).toContain(
        'Unable to resolve workflow execution order'
      );
      expect(persisted.status).toBe('error');
      expect(persisted.data?.resultData?.error?.message).toContain(
        'Unable to resolve workflow execution order'
      );
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('persists node execution through Smithers step storage', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const resultDir = await mkdtemp(join(tmpdir(), 'embedded-workflows-smithers-result-'));
    const resultPath = join(resultDir, 'result.json');
    const script = `
      import { Database } from 'bun:sqlite';
      import { mkdtemp, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import { resolveSmithersDbPath } from './src/services/smithers-runtime.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-smithers-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = {
        agentId: 'agent-test',
        character: { settings: {} },
        db,
        getSetting: (key) => key === 'WORKFLOW_SEED_DEFAULTS' ? false : null,
        getService: () => null,
      };
      const service = await EmbeddedWorkflowService.start(runtime);
      let smithersDbPath = null;
      try {
        const created = await service.createWorkflow({
          name: 'Smithers persistence',
          nodes: [
            { id: 'manual', name: 'Manual Trigger', type: 'workflows-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
            { id: 'set', name: 'Set', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: { assignments: { assignments: [{ name: 'smithersRecorded', value: true }] } } },
          ],
          connections: {
            'Manual Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
          },
        });

        const execution = await service.executeWorkflow(created.id);
        const item = execution.data?.resultData?.runData?.Set?.[0]?.data?.main?.[0]?.[0]?.json;
        const engine = execution.data?.resultData?.engine;
        smithersDbPath = resolveSmithersDbPath(runtime.agentId, created.id);
        const smithersDb = new Database(smithersDbPath, { readonly: true });
        try {
          const tables = smithersDb
            .query("select name from sqlite_master where type = 'table' and name like 'smithers_%' order by name")
            .all()
            .map((row) => row.name);
          const persistedSetRows = smithersDb
            .query('select payload from smithers_0001_set where node_id = ? order by iteration')
            .all('0001-set');
          await writeFile(
            process.env.WORKFLOW_SMITHERS_RESULT_PATH,
            JSON.stringify({
              status: execution.status,
              item,
              engine,
              tables,
              persistedSetRowsLength: persistedSetRows.length,
            })
          );
        } finally {
          smithersDb.close();
        }
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
        if (smithersDbPath) {
          await Promise.all([
            rm(smithersDbPath, { force: true }),
            rm(smithersDbPath + '-wal', { force: true }),
            rm(smithersDbPath + '-shm', { force: true }),
          ]);
        }
      }
    `;
    try {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          WORKFLOW_SMITHERS_RESULT_PATH: resultPath,
          WORKFLOW_DIAGNOSTICS_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        status?: string;
        item?: { smithersRecorded?: boolean };
        engine?: { provider?: string; nodes?: number; levels?: number; maxConcurrency?: number };
        tables?: string[];
        persistedSetRowsLength?: number;
      };
      expect(result.status).toBe('success');
      expect(result.item?.smithersRecorded).toBe(true);
      expect(result.engine).toMatchObject({
        provider: 'smithers',
        nodes: 2,
        levels: 2,
        maxConcurrency: 1,
      });
      expect(result.tables).toContain('smithers_0000_manual');
      expect(result.tables).toContain('smithers_0001_set');
      expect(result.tables).toContain('smithers_eliza_workflow_result');
      expect(result.persistedSetRowsLength).toBe(1);
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('executes active embedded webhooks through the plugin service', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const resultDir = await mkdtemp(join(tmpdir(), 'embedded-workflows-webhook-result-'));
    const resultPath = join(resultDir, 'result.json');
    const script = `
      import { mkdtemp, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-webhook-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = {
        agentId: 'agent-test',
        character: { settings: {} },
        db,
        getSetting: (key) => key === 'WORKFLOW_SEED_DEFAULTS' ? false : null,
        getService: () => null,
      };
      const service = await EmbeddedWorkflowService.start(runtime);
      try {
        const created = await service.createWorkflow({
          name: 'Webhook workflow',
          nodes: [
            { id: 'webhook', name: 'Webhook', type: 'workflows-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'incoming', httpMethod: 'POST' } },
            { id: 'set', name: 'Set', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: { assignments: { assignments: [{ name: 'handled', value: true }] } } },
          ],
          connections: {
            Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
          },
        });
        await service.activateWorkflow(created.id);
        const execution = await service.executeWebhook('incoming', { payload: 'ok' }, 'POST');
        const item = execution.data?.resultData?.runData?.Set?.[0]?.data?.main?.[0]?.[0]?.json;
        await writeFile(process.env.WORKFLOW_WEBHOOK_RESULT_PATH, JSON.stringify({ status: execution.status, item }));
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;
    try {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          WORKFLOW_WEBHOOK_RESULT_PATH: resultPath,
          WORKFLOW_DIAGNOSTICS_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        status?: string;
        item?: { payload?: string; handled?: boolean };
      };
      expect(result.status).toBe('success');
      expect(result.item?.payload).toBe('ok');
      expect(result.item?.handled).toBe(true);
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }, 60_000);
});
