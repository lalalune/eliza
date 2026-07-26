/**
 * Produces the public error envelope for durable workflow executions. Workflow
 * failures may contain request credentials, response bodies, or user data, so
 * only stable codes, fixed messages, and a small numeric/identifier context
 * allowlist may cross the Smithers protocol or enter persisted execution rows.
 */

import { ElizaError, type ElizaErrorSeverity } from '@elizaos/core';
import type { WorkflowExecution } from '../types/index';

export interface SafeWorkflowExecutionError {
  message: string;
  code: string;
  context?: Record<string, unknown>;
}

interface WorkflowExecutionErrorOptions {
  fallbackCode?: string;
  workflowId?: string;
  executionId?: string;
}

const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  WORKFLOW_EXECUTION_FAILED: 'Workflow execution failed',
  WORKFLOW_NODE_EXECUTION_FAILED: 'Workflow node execution failed',
  WORKFLOW_HTTP_URL_REQUIRED: 'HTTP Request node requires a URL',
  WORKFLOW_HTTP_TARGET_BLOCKED: 'HTTP request target was blocked by network policy',
  WORKFLOW_HTTP_STATUS_ERROR: 'HTTP request failed',
  WORKFLOW_HTTP_RESPONSE_TOO_LARGE: 'Workflow HTTP response exceeds the configured size limit',
  WORKFLOW_EXECUTION_LEASE_LOST: 'Workflow execution lease was lost',
  WORKFLOW_EXECUTION_RESULT_MISSING: 'Workflow execution completed without a result',
  WORKFLOW_SERVICE_STOPPED: 'Workflow execution stopped because the service is shutting down',
  WORKFLOW_SCHEDULE_NODE_NOT_FOUND: 'Workflow schedule node was not found',
  WORKFLOW_SCHEDULE_REQUIRES_ALWAYS_ON: 'Scheduled workflows require an always-on agent',
  WORKFLOW_RESPOND_RUNTIME_UNAVAILABLE: 'Workflow response could not access the agent runtime',
  WORKFLOW_RESPOND_OWNER_CONTEXT_REQUIRED:
    'Workflow response requires owner context in managed Cloud',
  WORKFLOW_RESPOND_AUTONOMY_UNAVAILABLE:
    'Workflow response could not access an autonomy service',
  WORKFLOW_RESPOND_ROOM_UNAVAILABLE: 'Workflow response could not resolve a destination room',
  WORKFLOW_RESPOND_EXECUTION_ID_UNAVAILABLE:
    'Workflow response could not identify its execution',
  WORKFLOW_DEFAULT_SEED_DELETION_CHECK_FAILED:
    'Default workflow deletion history could not be checked',
  SMITHERS_WORKFLOW_ABORTED: 'Smithers workflow execution was aborted',
  SMITHERS_WORKFLOW_TIMEOUT: 'Smithers workflow execution timed out',
  SMITHERS_WORKFLOW_FAILED: 'Smithers workflow execution failed',
  SMITHERS_WORKFLOW_RESULT_MISSING: 'Smithers completed without returning a workflow result',
  SMITHERS_PROTOCOL_INVALID: 'Smithers returned an invalid workflow protocol message',
  SMITHERS_PAYLOAD_PIPE_MISSING: 'Smithers workflow transport was unavailable',
  SMITHERS_TENANT_REQUIRED: 'Smithers workflow tenant is unavailable',
  SMITHERS_DB_PROVIDER_INVALID: 'Smithers database provider is invalid',
  SMITHERS_DB_URL_REQUIRED: 'Smithers PostgreSQL configuration is incomplete',
  SMITHERS_DB_DATA_DIR_REQUIRED: 'Smithers PGlite configuration is incomplete',
  SMITHERS_TIMEOUT_INVALID: 'Smithers workflow timeout configuration is invalid',
  SMITHERS_PLUGIN_ROOT_MISSING: 'Smithers workflow runtime is unavailable',
} as const;

function isSafeCode(code: string): boolean {
  return Object.hasOwn(SAFE_MESSAGES, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCode(error: unknown, fallbackCode: string): string {
  if (error instanceof ElizaError && isSafeCode(error.code)) return error.code;
  if (isRecord(error) && typeof error.code === 'string' && isSafeCode(error.code)) {
    return error.code;
  }
  if (error instanceof Error && error.name === 'SsrfBlockedError') {
    return 'WORKFLOW_HTTP_TARGET_BLOCKED';
  }
  return isSafeCode(fallbackCode) ? fallbackCode : 'WORKFLOW_EXECUTION_FAILED';
}

function readContext(error: unknown): Record<string, unknown> {
  if (error instanceof ElizaError && error.context) return error.context;
  if (isRecord(error) && isRecord(error.context)) return error.context;
  return {};
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) return undefined;
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return undefined;
  }
  return value as number;
}

function buildContext(
  error: unknown,
  options: WorkflowExecutionErrorOptions
): Record<string, unknown> | undefined {
  const source = readContext(error);
  const context: Record<string, unknown> = {};
  // Workflow and execution ids identify durable rows, so they must come from
  // the trusted caller rather than an arbitrary node error's context object.
  const workflowId = safeIdentifier(options.workflowId);
  const executionId = safeIdentifier(options.executionId);
  const method =
    typeof source.method === 'string' &&
    ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(source.method)
      ? source.method
      : undefined;
  const statusCode = safeInteger(source.statusCode, 100, 599);
  const maxBytes = safeInteger(source.maxBytes, 1, Number.MAX_SAFE_INTEGER);
  const actualBytes = safeInteger(source.actualBytes, 0, Number.MAX_SAFE_INTEGER);
  const timeoutMs = safeInteger(source.timeoutMs, 1, Number.MAX_SAFE_INTEGER);
  const exitCode = safeInteger(source.exitCode, 0, 255);

  if (workflowId) context.workflowId = workflowId;
  if (executionId) context.executionId = executionId;
  if (method) context.method = method;
  if (statusCode !== undefined) context.statusCode = statusCode;
  if (maxBytes !== undefined) context.maxBytes = maxBytes;
  if (actualBytes !== undefined) context.actualBytes = actualBytes;
  if (timeoutMs !== undefined) context.timeoutMs = timeoutMs;
  if (exitCode !== undefined) context.exitCode = exitCode;
  return Object.keys(context).length > 0 ? context : undefined;
}

function messageFor(code: string, context: Record<string, unknown> | undefined): string {
  if (code === 'WORKFLOW_HTTP_STATUS_ERROR' && typeof context?.statusCode === 'number') {
    return `HTTP request failed with status ${context.statusCode}`;
  }
  if (code === 'WORKFLOW_HTTP_RESPONSE_TOO_LARGE' && typeof context?.maxBytes === 'number') {
    return `Workflow HTTP response exceeds maximum size of ${context.maxBytes} bytes`;
  }
  if (code === 'SMITHERS_WORKFLOW_TIMEOUT' && typeof context?.timeoutMs === 'number') {
    return `Smithers workflow execution timed out after ${context.timeoutMs}ms`;
  }
  return SAFE_MESSAGES[code] ?? SAFE_MESSAGES.WORKFLOW_EXECUTION_FAILED;
}

export function serializeWorkflowExecutionError(
  error: unknown,
  options: WorkflowExecutionErrorOptions = {}
): SafeWorkflowExecutionError {
  const fallbackCode = options.fallbackCode ?? 'WORKFLOW_EXECUTION_FAILED';
  const code = readCode(error, fallbackCode);
  const context = buildContext(error, options);
  return {
    message: messageFor(code, context),
    code,
    ...(context ? { context } : {}),
  };
}

export function toSafeWorkflowExecutionError(
  error: unknown,
  options: WorkflowExecutionErrorOptions = {}
): ElizaError {
  const payload = serializeWorkflowExecutionError(error, options);
  const severity: ElizaErrorSeverity | undefined =
    error instanceof ElizaError ? error.severity : undefined;
  return new ElizaError(payload.message, {
    code: payload.code,
    ...(payload.context ? { context: payload.context } : {}),
    ...(severity ? { severity } : {}),
  });
}

export function sanitizeWorkflowExecution(execution: WorkflowExecution): WorkflowExecution {
  const error = execution.data?.resultData?.error;
  if (!error) return structuredClone(execution);
  return {
    ...structuredClone(execution),
    data: {
      ...structuredClone(execution.data),
      resultData: {
        ...structuredClone(execution.data?.resultData),
        error: serializeWorkflowExecutionError(error, {
          workflowId: execution.workflowId,
          executionId: execution.id,
        }),
      },
    },
  };
}
