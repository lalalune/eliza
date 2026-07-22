/** Unit tests for WORKFLOW_DISPATCH service creation, registration, and dispatch (deterministic, mocked core). */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as actualCore from '@elizaos/core';
import { logger } from '@elizaos/core';
import { EMBEDDED_WORKFLOW_SERVICE_TYPE } from '../../src/services/embedded-workflow-service';
import {
  createWorkflowDispatchService,
  registerWorkflowDispatchService,
  WORKFLOW_DISPATCH_SERVICE_TYPE,
} from '../../src/services/workflow-dispatch';
import type { WorkflowExecution } from '../../src/types/index';

// `mock.module` replaces the module globally for the rest of the bun-test run,
// so preserve every real `@elizaos/core` export and swap in a complete spy
// logger. A partial logger here would strip `.info`/`.error` (and `Service`)
// from every test file loaded afterward.
mock.module('@elizaos/core', () => ({
  ...actualCore,
  logger: {
    trace: mock(() => {}),
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    fatal: mock(() => {}),
    child: mock(() => logger),
  },
}));

function fakeExecution(id: string, overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    id,
    workflowId: 'wf-1',
    mode: 'trigger',
    status: 'success',
    finished: true,
    startedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function makeRuntime(service: unknown = null, loadPromise?: Promise<unknown>) {
  const services = new Map<string, unknown>();
  return {
    services,
    getService: mock((type: string) => (type === EMBEDDED_WORKFLOW_SERVICE_TYPE ? service : null)),
    ...(loadPromise
      ? {
          getServiceLoadPromise: mock((type: string) => {
            expect(type).toBe(EMBEDDED_WORKFLOW_SERVICE_TYPE);
            return loadPromise;
          }),
        }
      : {}),
  };
}

function makeEmbeddedService() {
  const executeWorkflow = mock(
    async (
      workflowId: string,
      options: {
        mode: string;
        triggerData: Record<string, unknown>;
        idempotencyKey?: string;
        scheduleNodeId?: string;
      }
    ): Promise<WorkflowExecution> =>
      fakeExecution(`${workflowId}:${options.idempotencyKey ?? 'fresh'}`, {
        workflowId,
      })
  );
  return {
    executeWorkflow,
    executeWorkflowWithDedup: mock(
      async (
        workflowId: string,
        options: {
          mode: string;
          triggerData: Record<string, unknown>;
          idempotencyKey?: string;
          scheduleNodeId?: string;
        }
      ) => ({ execution: await executeWorkflow(workflowId, options), dedup: false })
    ),
    findExecutionByIdempotencyKey: mock(
      async (_workflowId: string, _idempotencyKey: string) => null as WorkflowExecution | null
    ),
  };
}

describe('workflow dispatch service', () => {
  beforeEach(() => {
    (logger.warn as ReturnType<typeof mock>).mockClear();
  });

  it('rejects blank workflow ids before consulting the runtime', async () => {
    const runtime = makeRuntime();
    const dispatch = createWorkflowDispatchService(runtime as never);

    await expect(dispatch.execute('   ')).resolves.toEqual({
      ok: false,
      error: 'workflow id required',
    });
    expect(runtime.getService).not.toHaveBeenCalled();
  });

  it('returns a clear error when the embedded workflow service is absent', async () => {
    const dispatch = createWorkflowDispatchService(makeRuntime() as never);

    await expect(dispatch.execute('wf-1')).resolves.toEqual({
      ok: false,
      error: 'embedded workflow service not registered',
    });
  });

  it('waits for the embedded workflow service to finish starting before dispatching', async () => {
    let markReady!: (service: unknown) => void;
    const ready = new Promise<unknown>((resolve) => {
      markReady = resolve;
    });
    const embedded = makeEmbeddedService();
    const runtime = makeRuntime(null, ready);
    const dispatch = createWorkflowDispatchService(runtime as never);

    const pending = dispatch.execute('wf-1');
    await Promise.resolve();
    expect(embedded.executeWorkflow).not.toHaveBeenCalled();

    markReady(embedded);
    await expect(pending).resolves.toEqual({
      ok: true,
      executionId: 'wf-1:fresh',
    });
    expect(runtime.getServiceLoadPromise).toHaveBeenCalledTimes(1);
    expect(embedded.executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('delegates to executeWorkflow with stripped payload idempotency keys', async () => {
    const embedded = makeEmbeddedService();
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(
      dispatch.execute(
        ' wf-1 ',
        {
          __idempotencyKey: 'tick-1',
          source: 'schedule',
        },
        { scheduleNodeId: 'schedule-a' }
      )
    ).resolves.toEqual({
      ok: true,
      executionId: 'wf-1:tick-1',
    });
    expect(embedded.findExecutionByIdempotencyKey).toHaveBeenCalledWith('wf-1', 'tick-1');
    expect(embedded.executeWorkflowWithDedup).toHaveBeenCalledWith('wf-1', {
      mode: 'trigger',
      triggerData: { source: 'schedule' },
      idempotencyKey: 'tick-1',
      scheduleNodeId: 'schedule-a',
    });
  });

  it('returns a dedup result for an existing idempotency row', async () => {
    const embedded = makeEmbeddedService();
    embedded.findExecutionByIdempotencyKey.mockImplementation(async () =>
      fakeExecution('existing-execution')
    );
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' })).resolves.toEqual({
      ok: true,
      executionId: 'existing-execution',
      dedup: true,
    });
    expect(embedded.executeWorkflowWithDedup).not.toHaveBeenCalled();
  });

  it('preserves a persisted terminal failure when a scheduled delivery is retried', async () => {
    const embedded = makeEmbeddedService();
    embedded.findExecutionByIdempotencyKey.mockImplementation(async () =>
      fakeExecution('failed-execution', {
        status: 'error',
        data: {
          resultData: {
            error: { message: 'HTTP node rejected the request' },
          },
        },
      })
    );
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' })).resolves.toEqual({
      ok: false,
      error: 'HTTP node rejected the request',
      executionId: 'failed-execution',
      dedup: true,
    });
    expect(embedded.executeWorkflowWithDedup).not.toHaveBeenCalled();
  });

  it('accepts an in-flight durable execution without launching a second side effect', async () => {
    const embedded = makeEmbeddedService();
    embedded.findExecutionByIdempotencyKey.mockImplementation(async () =>
      fakeExecution('running-execution', {
        status: 'running',
        finished: false,
      })
    );
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' })).resolves.toEqual({
      ok: true,
      executionId: 'running-execution',
      dedup: true,
    });
    expect(embedded.executeWorkflowWithDedup).not.toHaveBeenCalled();
  });

  it('propagates a database-claim dedup result when the fast lookup raced', async () => {
    const embedded = makeEmbeddedService();
    embedded.executeWorkflowWithDedup.mockImplementation(async () => ({
      execution: fakeExecution('claimed-by-another-runtime'),
      dedup: true,
    }));
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' })).resolves.toEqual({
      ok: true,
      executionId: 'claimed-by-another-runtime',
      dedup: true,
    });
  });

  it('preserves a failed database-claim result when the fast lookup raced', async () => {
    const embedded = makeEmbeddedService();
    embedded.executeWorkflowWithDedup.mockImplementation(async () => ({
      execution: fakeExecution('failed-race-winner', {
        status: 'crashed',
        data: {
          resultData: {
            error: { message: 'Smithers worker exited unexpectedly' },
          },
        },
      }),
      dedup: true,
    }));
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' })).resolves.toEqual({
      ok: false,
      error: 'Smithers worker exited unexpectedly',
      executionId: 'failed-race-winner',
      dedup: true,
    });
  });

  it('collapses concurrent dispatches with the same idempotency key', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embedded = makeEmbeddedService();
    embedded.executeWorkflow.mockImplementation(async () => {
      await gate;
      return fakeExecution('execution-1');
    });
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    const first = dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' });
    const second = dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, executionId: 'execution-1' },
      { ok: true, executionId: 'execution-1', dedup: true },
    ]);
    expect(embedded.executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('marks a coalesced failed caller as deduped without rerunning the workflow', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embedded = makeEmbeddedService();
    embedded.executeWorkflow.mockImplementation(async () => {
      await gate;
      throw new Error('engine offline');
    });
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    const first = dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' });
    const second = dispatch.execute('wf-1', {}, { idempotencyKey: 'tick-1' });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: false, error: 'engine offline' },
      { ok: false, error: 'engine offline', dedup: true },
    ]);
    expect(embedded.executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('wraps execution failures without throwing', async () => {
    const embedded = makeEmbeddedService();
    embedded.executeWorkflow.mockImplementation(async () => {
      throw new Error('engine offline');
    });
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(dispatch.execute('wf-1')).resolves.toEqual({
      ok: false,
      error: 'engine offline',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { src: 'plugin:workflow:dispatch' },
      'Workflow execution failed for wf-1: engine offline'
    );
  });

  it('registers a stoppable service entry in the runtime services map', async () => {
    const runtime = makeRuntime(makeEmbeddedService());

    registerWorkflowDispatchService(runtime as never);

    const entries = runtime.services.get(WORKFLOW_DISPATCH_SERVICE_TYPE);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toEqual(
      expect.objectContaining({
        capabilityDescription:
          'Executes embedded workflows by id via the in-process workflow service.',
      })
    );
    await expect(entries?.[0].execute('wf-1')).resolves.toEqual({
      ok: true,
      executionId: 'wf-1:fresh',
    });
    await expect(entries?.[0].stop()).resolves.toBeUndefined();
  });
});
