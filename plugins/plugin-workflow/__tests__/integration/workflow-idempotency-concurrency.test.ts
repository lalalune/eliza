/**
 * Verifies durable workflow idempotency across independent service instances
 * sharing a real PGlite store, including recovery of a committed pending claim.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { logger, stringToUuid } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import {
  resolveSmithersDbPath,
  resolveSmithersTimeoutMs,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinition, WorkflowExecution } from '../../src/types/index';

async function makeSharedHarness(seed: string) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-idempotency-concurrency-'));
  const client = new PGlite({ dataDir: join(root, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const agentId = stringToUuid(seed);
  const instances: EmbeddedWorkflowService[] = [];
  const memoryWrites: Array<{ instance: string; memory: unknown }> = [];
  const smithersPaths = new Set<string>();

  return {
    agentId,
    db,
    memoryWrites,
    trackWorkflow(workflowId: string) {
      smithersPaths.add(resolveSmithersDbPath(agentId, workflowId));
    },
    async startInstance(instance: string) {
      const services = new Map<string, unknown>();
      const autonomy = { getAutonomousRoomId: () => stringToUuid(`${seed}-room`) };
      const runtime = {
        agentId,
        character: { settings: { WORKFLOW_SEED_DEFAULTS: 'false' } },
        db,
        logger,
        getSetting: (key: string) => (key === 'WORKFLOW_SEED_DEFAULTS' ? 'false' : undefined),
        getService: (type: string) => {
          if (type === 'AUTONOMY' || type === 'autonomy') return autonomy;
          return services.get(type) ?? null;
        },
        createMemory: async (memory: unknown) => {
          memoryWrites.push({ instance, memory });
          return stringToUuid(`${seed}-${instance}-${memoryWrites.length}`);
        },
      } as never;
      const workflow = await EmbeddedWorkflowService.start(runtime);
      services.set(EMBEDDED_WORKFLOW_SERVICE_TYPE, workflow);
      instances.push(workflow);
      return workflow;
    },
    async close() {
      for (const instance of instances) await instance.stop();
      await client.close();
      await rm(root, { recursive: true, force: true });
      await Promise.all(
        [...smithersPaths].flatMap((path) => [
          rm(path, { force: true }),
          rm(`${path}-wal`, { force: true }),
          rm(`${path}-shm`, { force: true }),
        ])
      );
    },
  };
}

function idempotentWorkflow(id: string, waitMs = 200): WorkflowDefinition {
  return {
    id,
    name: 'Shared idempotency claim',
    nodes: [
      {
        id: 'schedule',
        name: 'Schedule Trigger',
        type: 'workflows-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'wait',
        name: 'Overlap Window',
        type: 'workflows-nodes-base.wait',
        typeVersion: 1.1,
        position: [200, 0],
        parameters: { amount: waitMs, unit: 'milliseconds' },
      },
      {
        id: 'effect',
        name: 'Record Effect',
        type: 'workflows-nodes-base.respondToEvent',
        typeVersion: 1,
        position: [400, 0],
        parameters: { instructions: 'Record the idempotent dispatch.' },
      },
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Overlap Window', type: 'main', index: 0 }]],
      },
      'Overlap Window': {
        main: [[{ node: 'Record Effect', type: 'main', index: 0 }]],
      },
    },
  };
}

async function waitForFinishedExecution(
  service: EmbeddedWorkflowService,
  executionId: string
): Promise<WorkflowExecution> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const execution = await service.getExecution(executionId);
    if (execution.finished) return execution;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`workflow execution ${executionId} did not finish before the deadline`);
}

test('two services atomically share one idempotency claim before node side effects', async () => {
  const harness = await makeSharedHarness(`workflow-idempotency-${crypto.randomUUID()}`);
  try {
    const firstService = await harness.startInstance('first');
    const secondService = await harness.startInstance('second');
    const workflowId = `shared-claim-${crypto.randomUUID()}`;
    harness.trackWorkflow(workflowId);
    await firstService.createWorkflow(idempotentWorkflow(workflowId));

    const [first, second] = await Promise.all([
      firstService.executeWorkflowWithDedup(workflowId, {
        mode: 'trigger',
        idempotencyKey: 'schedule-window-1',
      }),
      secondService.executeWorkflowWithDedup(workflowId, {
        mode: 'trigger',
        idempotencyKey: 'schedule-window-1',
      }),
    ]);

    expect(first.execution.id).toBe(second.execution.id);
    expect([first.dedup, second.dedup].sort()).toEqual([false, true]);
    const { data: executions } = await firstService.listExecutions({ workflowId });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ status: 'success', finished: true });
    expect(harness.memoryWrites).toHaveLength(1);
  } finally {
    await harness.close();
  }
}, 120_000);

test('a live stalled owner remains fenced from another service recovery loop', async () => {
  const harness = await makeSharedHarness(`workflow-live-lease-${crypto.randomUUID()}`);
  try {
    const owner = await harness.startInstance('owner');
    const observer = await harness.startInstance('observer');
    const workflowId = `live-lease-${crypto.randomUUID()}`;
    harness.trackWorkflow(workflowId);
    await owner.createWorkflow(idempotentWorkflow(workflowId, 3_000));

    const run = owner.executeWorkflowWithDedup(workflowId, {
      mode: 'trigger',
      idempotencyKey: 'live-stalled-owner',
      scheduleNodeId: 'schedule',
    });
    const deadline = Date.now() + 10_000;
    let runningRow: typeof dbSchema.embeddedExecutions.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const rows = await harness.db
        .select()
        .from(dbSchema.embeddedExecutions)
        .where(
          and(
            eq(dbSchema.embeddedExecutions.agentId, harness.agentId),
            eq(dbSchema.embeddedExecutions.workflowId, workflowId)
          )
        );
      runningRow = rows[0];
      if (runningRow?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(runningRow).toMatchObject({ status: 'running', finished: false });
    expect(runningRow?.executionOwnerId).toBeTruthy();
    expect((runningRow?.executionLeaseExpiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      resolveSmithersTimeoutMs()
    );

    // The observer gets a complete recovery polling cycle while the owner's
    // delegated Wait node is stalled, but the unexpired outer lease bars it.
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    expect((await observer.listExecutions({ workflowId })).data).toHaveLength(1);
    const afterObserverPoll = await harness.db
      .select()
      .from(dbSchema.embeddedExecutions)
      .where(
        and(
          eq(dbSchema.embeddedExecutions.agentId, harness.agentId),
          eq(dbSchema.embeddedExecutions.workflowId, workflowId)
        )
      );
    expect(afterObserverPoll[0]?.executionOwnerId).toBe(runningRow?.executionOwnerId);
    expect(harness.memoryWrites).toHaveLength(0);

    const completed = await run;
    expect(completed).toMatchObject({ dedup: false, execution: { status: 'success' } });
    expect(harness.memoryWrites).toHaveLength(1);
  } finally {
    await harness.close();
  }
}, 120_000);

test('two startup services atomically lease one crash-pending claim and recover one side effect', async () => {
  const harness = await makeSharedHarness(`workflow-pending-${crypto.randomUUID()}`);
  try {
    const firstService = await harness.startInstance('claimant');
    const secondService = await harness.startInstance('duplicate');
    const workflowId = `pending-claim-${crypto.randomUUID()}`;
    const executionId = `pending-execution-${crypto.randomUUID()}`;
    const idempotencyKey = 'schedule-window-crash';
    harness.trackWorkflow(workflowId);
    const created = await firstService.createWorkflow(idempotentWorkflow(workflowId));
    const workflow = created as WorkflowDefinition;
    const pending: WorkflowExecution = {
      id: executionId,
      workflowId,
      mode: 'trigger',
      status: 'running',
      finished: false,
      startedAt: new Date().toISOString(),
      customData: {
        idempotencyKey,
        smithersResumeState: { version: 1, workflow },
      },
    };
    await harness.db.insert(dbSchema.embeddedExecutions).values({
      agentId: harness.agentId,
      id: executionId,
      workflowId,
      status: 'running',
      mode: 'trigger',
      finished: false,
      startedAt: pending.startedAt,
      stoppedAt: null,
      execution: pending,
      idempotencyKey,
      executionOwnerId: 'still-running-runtime',
      executionLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
    });

    // Both live recovery loops get at least one polling opportunity, but the
    // unexpired outer lease fences them even though no Smithers worker exists.
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    expect(harness.memoryWrites).toHaveLength(0);
    expect(await secondService.getExecution(executionId)).toMatchObject({
      id: executionId,
      status: 'running',
      finished: false,
    });

    const duplicate = await secondService.executeWorkflowWithDedup(workflowId, {
      mode: 'trigger',
      idempotencyKey,
    });
    expect(duplicate).toMatchObject({
      dedup: true,
      execution: { id: executionId, status: 'running', finished: false },
    });
    expect(harness.memoryWrites).toHaveLength(0);
    expect((await secondService.listExecutions({ workflowId })).data).toHaveLength(1);

    await firstService.stop();
    await secondService.stop();
    await harness.db
      .update(dbSchema.embeddedExecutions)
      .set({
        executionOwnerId: 'crashed-runtime',
        executionLeaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(
        and(
          eq(dbSchema.embeddedExecutions.agentId, harness.agentId),
          eq(dbSchema.embeddedExecutions.id, executionId)
        )
      );
    const [recoveryA, recoveryB] = await Promise.all([
      harness.startInstance('recovery-a'),
      harness.startInstance('recovery-b'),
    ]);
    const recovered = await waitForFinishedExecution(recoveryA, executionId);
    expect(recovered).toMatchObject({ id: executionId, status: 'success', finished: true });
    expect(harness.memoryWrites).toHaveLength(1);
    expect((await recoveryB.listExecutions({ workflowId })).data).toHaveLength(1);
  } finally {
    await harness.close();
  }
}, 120_000);

test('historical duplicate rows remain readable without creating another execution', async () => {
  const harness = await makeSharedHarness(`workflow-history-${crypto.randomUUID()}`);
  try {
    const service = await harness.startInstance('reader');
    const workflowId = `historical-duplicates-${crypto.randomUUID()}`;
    const idempotencyKey = 'historical-window';
    await service.createWorkflow(idempotentWorkflow(workflowId));

    const rows = [
      { id: 'older-execution', startedAt: '2026-07-20T10:00:00.000Z' },
      { id: 'newer-execution', startedAt: '2026-07-20T10:01:00.000Z' },
    ];
    for (const row of rows) {
      const execution: WorkflowExecution = {
        id: row.id,
        workflowId,
        mode: 'trigger',
        status: 'success',
        finished: true,
        startedAt: row.startedAt,
        stoppedAt: row.startedAt,
        customData: { idempotencyKey },
      };
      await harness.db.insert(dbSchema.embeddedExecutions).values({
        agentId: harness.agentId,
        id: execution.id,
        workflowId,
        status: execution.status,
        mode: execution.mode,
        finished: execution.finished,
        startedAt: execution.startedAt,
        stoppedAt: execution.stoppedAt,
        execution,
        idempotencyKey,
      });
    }

    const result = await service.executeWorkflowWithDedup(workflowId, {
      mode: 'trigger',
      idempotencyKey,
    });
    expect(result).toMatchObject({
      dedup: true,
      execution: { id: 'newer-execution', status: 'success' },
    });
    expect((await service.listExecutions({ workflowId })).data).toHaveLength(2);
    expect(harness.memoryWrites).toHaveLength(0);
  } finally {
    await harness.close();
  }
}, 120_000);
