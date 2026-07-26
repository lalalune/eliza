/**
 * Workflow dispatch service - executes a workflow by id via the in-process
 * EmbeddedWorkflowService registered by `@elizaos/plugin-workflow`.
 *
 * Consumed by the trigger dispatcher: triggers carrying `kind: "workflow"`
 * resolve a workflow id and call
 *   runtime.getService("WORKFLOW_DISPATCH").execute(workflowId).
 *
 * Registered into the runtime services map by the plugin's `init` (see
 * `plugins/plugin-workflow/src/index.ts`).
 *
 * The dispatch service is a thin routing layer - it looks up the embedded
 * workflow service on the runtime and delegates through its durable execution
 * boundary. There is no HTTP boundary and no sidecar lifecycle.
 */

import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { WorkflowExecution } from '../types/index';
import { isManagedCloudRuntime } from '../utils/context';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from './embedded-workflow-service';
import {
  serializeWorkflowExecutionError,
  toSafeWorkflowExecutionError,
} from './workflow-execution-error';

export const WORKFLOW_DISPATCH_SERVICE_TYPE = 'WORKFLOW_DISPATCH' as const;

export interface WorkflowDispatchResult {
  ok: boolean;
  error?: string;
  executionId?: string;
  /**
   * True when the call was short-circuited by an idempotency-key match.
   * Callers (the trigger dispatcher, dashboards) can record a dedup
   * instead of treating the call as a fresh execution.
   */
  dedup?: boolean;
}

/**
 * Optional, structured dispatch options. The `idempotencyKey` field is
 * the durable contract: same workflow + same key → at most one
 * execution. Passed inline through the legacy `payload` shape (key
 * `__idempotencyKey`) when the caller can't pass a second argument. A scheduled
 * task also supplies `scheduleNodeId` so execution starts at that exact branch.
 */
export interface WorkflowDispatchOptions {
  triggerData?: Record<string, unknown>;
  idempotencyKey?: string;
  scheduleNodeId?: string;
  ownerEntityId?: string;
  sourceRoomId?: string;
}

export interface WorkflowDispatchService {
  execute(
    workflowId: string,
    payload?: Record<string, unknown>,
    options?: WorkflowDispatchOptions
  ): Promise<WorkflowDispatchResult>;
}

interface WorkflowDispatchServiceEntry extends WorkflowDispatchService {
  stop(): Promise<void>;
  capabilityDescription: string;
}

/**
 * Pull `__idempotencyKey` out of the legacy `payload` shape so existing
 * callers (the trigger dispatcher's `event` payload) can attach a key
 * without growing the signature. The wrapper key is stripped before the
 * payload is forwarded as `triggerData`.
 */
function partitionPayload(payload: Record<string, unknown> | undefined): {
  triggerData: Record<string, unknown>;
  idempotencyKey?: string;
} {
  if (!payload) return { triggerData: {} };
  const { __idempotencyKey, ...rest } = payload;
  return {
    triggerData: rest,
    idempotencyKey: typeof __idempotencyKey === 'string' ? __idempotencyKey : undefined,
  };
}

interface RuntimeServiceRegistry {
  set(serviceType: string, services: WorkflowDispatchServiceEntry[]): void;
}

function isEmbeddedWorkflowService(value: unknown): value is EmbeddedWorkflowService {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'executeWorkflow') === 'function' &&
    typeof Reflect.get(value, 'executeWorkflowWithDedup') === 'function' &&
    typeof Reflect.get(value, 'findExecutionByIdempotencyKey') === 'function'
  );
}

async function resolveEmbeddedService(
  runtime: IAgentRuntime
): Promise<EmbeddedWorkflowService | null> {
  const service = runtime.getService<EmbeddedWorkflowService>(EMBEDDED_WORKFLOW_SERVICE_TYPE);
  if (isEmbeddedWorkflowService(service)) return service;

  const getServiceLoadPromise: unknown = Reflect.get(runtime, 'getServiceLoadPromise');
  if (typeof getServiceLoadPromise !== 'function') return null;

  const loaded: unknown = await Reflect.apply(getServiceLoadPromise, runtime, [
    EMBEDDED_WORKFLOW_SERVICE_TYPE,
  ]);
  return isEmbeddedWorkflowService(loaded) ? loaded : null;
}

function getRuntimeServiceRegistry(runtime: IAgentRuntime): RuntimeServiceRegistry | null {
  const services: unknown = Reflect.get(runtime, 'services');
  if (!services || typeof services !== 'object') {
    return null;
  }

  const set: unknown = Reflect.get(services, 'set');
  if (typeof set !== 'function') {
    return null;
  }

  return {
    set(serviceType, serviceEntries) {
      Reflect.apply(set, services, [serviceType, serviceEntries]);
    },
  };
}

/**
 * Construct the dispatch service. Registered under `WORKFLOW_DISPATCH` on the
 * runtime by the plugin's `init` lifecycle hook.
 *
 * Idempotency contract: when a caller passes an `idempotencyKey` (either via
 * the explicit `options.idempotencyKey` or via the legacy
 * `payload.__idempotencyKey`), the dispatch service first looks up an
 * existing execution row for `(workflowId, idempotencyKey)`. If one exists,
 * the new run is suppressed and the prior execution result is returned with
 * `dedup: true`. A prior terminal failure stays a failure; an in-flight or
 * successful prior execution is accepted without launching another run.
 * Scheduled workflow dispatches use an occurrence-specific key so retries
 * collapse without suppressing later sub-minute occurrences.
 *
 * The lookup is only a fast path. The embedded service serializes claimants
 * in the shared database and commits the winning pending execution before
 * any workflow node runs, so separate runtime processes cannot both perform
 * side effects for the same key.
 */
export function createWorkflowDispatchService(runtime: IAgentRuntime): WorkflowDispatchService {
  // Track in-flight executions by `(workflowId, idempotencyKey)` so that
  // two concurrent dispatches inside the same process collapse onto one
  // run. The map entry resolves once the original run finishes, and the
  // late caller returns the same execution id.
  const inflight = new Map<string, Promise<WorkflowDispatchResult>>();

  return {
    async execute(
      workflowId: string,
      payload: Record<string, unknown> = {},
      options: WorkflowDispatchOptions = {}
    ): Promise<WorkflowDispatchResult> {
      const id = workflowId.trim();
      if (!id) {
        return { ok: false, error: 'workflow id required' };
      }
      const ownerEntityId = options.ownerEntityId?.trim() || undefined;
      if (isManagedCloudRuntime(runtime) && !ownerEntityId) {
        return { ok: false, error: 'workflow owner context required in managed Cloud' };
      }
      let service: EmbeddedWorkflowService | null;
      try {
        service = await resolveEmbeddedService(runtime);
      } catch {
        // error-policy:J1 scheduled-trigger dispatch translates startup failure
        // into the explicit failure result consumed by the scheduler boundary.
        return { ok: false, error: 'embedded workflow service failed to start' };
      }
      if (!service) {
        return { ok: false, error: 'embedded workflow service not registered' };
      }

      if (ownerEntityId) {
        const ownerScopedService = runtime.getService('workflow') as unknown as {
          getWorkflow(id: string, userId: string): Promise<unknown>;
        } | null;
        if (!ownerScopedService || typeof ownerScopedService.getWorkflow !== 'function') {
          return { ok: false, error: 'owner-scoped workflow service not registered' };
        }
        try {
          await ownerScopedService.getWorkflow(id, ownerEntityId);
        } catch {
          // error-policy:J1 the trigger dispatch boundary returns an explicit
          // failed dispatch after the owner-scoped facade denies access.
          return { ok: false, error: 'workflow not found or not owned by caller' };
        }
      }

      const partitioned = partitionPayload(payload);
      const triggerData =
        options.triggerData && Object.keys(options.triggerData).length > 0
          ? options.triggerData
          : partitioned.triggerData;
      const idempotencyKey = options.idempotencyKey ?? partitioned.idempotencyKey;

      if (idempotencyKey) {
        const existing = await service.findExecutionByIdempotencyKey(id, idempotencyKey);
        if (existing) {
          return resultFromExecution(existing, true);
        }

        const inflightKey = `${ownerEntityId ?? ''}::${id}::${idempotencyKey}`;
        const pending = inflight.get(inflightKey);
        if (pending) {
          const result = await pending;
          return { ...result, dedup: true };
        }

        const promise = runDispatch(
          service,
          id,
          triggerData,
          idempotencyKey,
          options.scheduleNodeId,
          ownerEntityId,
          options.sourceRoomId
        ).finally(() => {
          inflight.delete(inflightKey);
        });
        inflight.set(inflightKey, promise);
        return promise;
      }

      return runDispatch(
        service,
        id,
        triggerData,
        undefined,
        options.scheduleNodeId,
        ownerEntityId,
        options.sourceRoomId
      );
    },
  };
}

async function runDispatch(
  service: EmbeddedWorkflowService,
  workflowId: string,
  triggerData: Record<string, unknown>,
  idempotencyKey: string | undefined,
  scheduleNodeId: string | undefined,
  ownerEntityId: string | undefined,
  sourceRoomId: string | undefined
): Promise<WorkflowDispatchResult> {
  try {
    if (idempotencyKey) {
      const result = await service.executeWorkflowWithDedup(workflowId, {
        mode: 'trigger',
        triggerData,
        idempotencyKey,
        scheduleNodeId,
        ...(ownerEntityId ? { ownerEntityId } : {}),
        ...(sourceRoomId ? { sourceRoomId } : {}),
      });
      return resultFromExecution(result.execution, result.dedup);
    }

    const execution = await service.executeWorkflow(workflowId, {
      mode: 'trigger',
      triggerData,
      scheduleNodeId,
      ...(ownerEntityId ? { ownerEntityId } : {}),
      ...(sourceRoomId ? { sourceRoomId } : {}),
    });
    return execution.id ? { ok: true, executionId: execution.id } : { ok: true };
  } catch (err) {
    const safeError = toSafeWorkflowExecutionError(err, {
      workflowId,
      fallbackCode: 'WORKFLOW_DISPATCH_FAILED',
    });
    logger.warn(
      {
        src: 'plugin:workflow:dispatch',
        workflowId,
        error: serializeWorkflowExecutionError(safeError, { workflowId }),
      },
      'Workflow execution failed'
    );
    return { ok: false, error: 'workflow execution failed' };
  }
}

function resultFromExecution(execution: WorkflowExecution, dedup: boolean): WorkflowDispatchResult {
  const executionId = execution.id || undefined;
  const common = {
    ...(executionId ? { executionId } : {}),
    ...(dedup ? { dedup: true } : {}),
  };
  const acceptedPending =
    execution.finished === false &&
    (execution.status === 'new' ||
      execution.status === 'running' ||
      execution.status === 'waiting');
  const acceptedSuccess = execution.finished === true && execution.status === 'success';
  if (acceptedSuccess || acceptedPending) {
    return { ok: true, ...common };
  }
  const persistedError = execution.data?.resultData?.error?.message?.trim();
  return {
    ok: false,
    error:
      persistedError ||
      `Workflow execution ${executionId ?? '(unknown)'} ended with status ${execution.status}`,
    ...common,
  };
}

/**
 * Register the dispatch service in the runtime services map under
 * `WORKFLOW_DISPATCH`. Called from the plugin's `init`.
 *
 * The runtime's `registerService(ServiceClass)` API expects a class with a
 * static `start()`. The dispatch is a closure-based singleton, so we set the
 * services map slot directly (mirrors `runtime/plugin-lifecycle.ts` and
 * `test/scripts/*.ts`).
 */
export function registerWorkflowDispatchService(runtime: IAgentRuntime): void {
  const dispatch = createWorkflowDispatchService(runtime);
  const serviceEntry: WorkflowDispatchServiceEntry = {
    execute: dispatch.execute.bind(dispatch),
    stop: async () => {},
    capabilityDescription: 'Executes embedded workflows by id via the in-process workflow service.',
  };
  getRuntimeServiceRegistry(runtime)?.set(WORKFLOW_DISPATCH_SERVICE_TYPE, [serviceEntry]);
}
