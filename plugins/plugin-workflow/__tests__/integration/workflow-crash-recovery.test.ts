/**
 * Exercises workflow crash recovery with real PGlite persistence and the real
 * Smithers worker. Stopping the owning service after an HTTP side effect is
 * durable must cancel its worker, release the execution lease, and let a fresh
 * service finish the same execution without issuing that side effect again.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stringToUuid } from '@elizaos/core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import {
  __setWorkflowHttpTransportForTests,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import { resolveSmithersDbPath } from '../../src/services/smithers-runtime';
import type { WorkflowExecution } from '../../src/types/index';

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
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
  throw new Error(`workflow execution ${executionId} did not recover before the deadline`);
}

test('startup resumes a killed execution without duplicating its persisted side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-crash-recovery-'));
  const client = new PGlite({ dataDir: join(root, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const agentId = stringToUuid(`workflow-crash-recovery-${root}`);
  const runtime = {
    agentId,
    character: { settings: { WORKFLOW_SEED_DEFAULTS: 'false' } },
    db,
    getSetting: (key: string) => (key === 'WORKFLOW_SEED_DEFAULTS' ? 'false' : undefined),
    getService: () => null,
  } as never;
  const server = createServer();
  let sideEffectCalls = 0;
  let holdCalls = 0;
  server.on('request', (request, response) => {
    if (request.url === '/hold') {
      holdCalls += 1;
      if (holdCalls === 1) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ resumed: true }));
      return;
    }
    sideEffectCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ created: sideEffectCalls }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  const workflowId = `crash-recovery-${crypto.randomUUID()}`;
  const smithersDbPath = resolveSmithersDbPath(agentId, workflowId);
  let firstService: EmbeddedWorkflowService | undefined;
  let recoveredService: EmbeddedWorkflowService | undefined;

  try {
    // The production policy rejects loopback. This real local-server harness
    // opts into private-network access through the guarded transport seam.
    __setWorkflowHttpTransportForTests(runtime, {
      fetchImpl: globalThis.fetch,
      policy: { allowPrivateNetwork: true },
    });
    firstService = await EmbeddedWorkflowService.start(runtime);
    await firstService.createWorkflow({
      id: workflowId,
      name: 'Crash recovery',
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
          id: 'side-effect',
          name: 'Create Once',
          type: 'workflows-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: {
            method: 'POST',
            url: `http://127.0.0.1:${address.port}/side-effect`,
            jsonBody: { value: 'once' },
          },
        },
        {
          id: 'hold',
          name: 'Hold Until Restart',
          type: 'workflows-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [400, 0],
          parameters: {
            method: 'GET',
            url: `http://127.0.0.1:${address.port}/hold`,
          },
        },
        {
          id: 'finish',
          name: 'Finish',
          type: 'workflows-nodes-base.set',
          typeVersion: 3.4,
          position: [600, 0],
          parameters: {
            assignments: { assignments: [{ name: 'finished', value: true }] },
          },
        },
      ],
      connections: {
        'Manual Trigger': {
          main: [[{ node: 'Create Once', type: 'main', index: 0 }]],
        },
        'Create Once': {
          main: [[{ node: 'Hold Until Restart', type: 'main', index: 0 }]],
        },
        'Hold Until Restart': {
          main: [[{ node: 'Finish', type: 'main', index: 0 }]],
        },
      },
    });

    const interruptedRun = firstService.executeWorkflow(workflowId).then(
      (execution) => ({ execution }),
      (error: unknown) => ({ error })
    );
    await waitForCondition(() => holdCalls === 1, 'the post-side-effect node to start');
    const inFlight = (await firstService.listExecutions({ workflowId })).data[0];
    if (!inFlight) throw new Error('in-flight workflow execution was not persisted');
    const executionId = inFlight.id;
    expect(sideEffectCalls).toBe(1);

    await firstService.stop();
    const interrupted = await interruptedRun;
    expect('error' in interrupted).toBe(true);
    if (!('error' in interrupted)) throw new Error('workflow unexpectedly completed during stop');
    expect(interrupted.error).toMatchObject({ code: 'SMITHERS_WORKFLOW_ABORTED' });

    const releasedRows = await db
      .select()
      .from(dbSchema.embeddedExecutions)
      .where(eq(dbSchema.embeddedExecutions.id, executionId));
    expect(releasedRows[0]).toMatchObject({
      status: 'running',
      finished: false,
      executionOwnerId: null,
    });
    const executionCountAfterStop = (await firstService.listExecutions({ workflowId })).data.length;
    await expect(firstService.executeWorkflow(workflowId)).rejects.toMatchObject({
      code: 'WORKFLOW_SERVICE_STOPPED',
    });
    expect((await firstService.listExecutions({ workflowId })).data).toHaveLength(
      executionCountAfterStop
    );

    recoveredService = await EmbeddedWorkflowService.start(runtime);
    const recovered = await waitForFinishedExecution(recoveredService, executionId);

    expect(recovered).toMatchObject({
      id: executionId,
      workflowId,
      status: 'success',
      finished: true,
    });
    expect(sideEffectCalls).toBe(1);
    expect(holdCalls).toBe(2);
    expect(Object.keys(recovered.data?.resultData?.runData ?? {}).sort()).toEqual([
      'Create Once',
      'Finish',
      'Hold Until Restart',
      'Manual Trigger',
    ]);
    expect(recovered.data?.resultData?.engine).toMatchObject({
      provider: 'smithers',
      nodes: 4,
      started: 4,
      finished: 4,
    });
  } finally {
    __setWorkflowHttpTransportForTests(runtime, undefined);
    await recoveredService?.stop();
    await firstService?.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.close();
    await rm(root, { recursive: true, force: true });
    await Promise.all([
      rm(smithersDbPath, { force: true }),
      rm(`${smithersDbPath}-wal`, { force: true }),
      rm(`${smithersDbPath}-shm`, { force: true }),
    ]);
  }
}, 120_000);
