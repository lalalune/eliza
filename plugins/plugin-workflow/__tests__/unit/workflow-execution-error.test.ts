/**
 * Verifies the durable workflow error boundary against secret-bearing thrown
 * values and historical execution rows. The suite uses the real serializer so
 * protocol, persistence, and API reads share one fixed public envelope.
 */

import { describe, expect, test } from 'bun:test';
import { ElizaError } from '@elizaos/core';
import {
  sanitizeWorkflowExecution,
  serializeWorkflowExecutionError,
  toSafeWorkflowExecutionError,
} from '../../src/services/workflow-execution-error';
import type { WorkflowExecution } from '../../src/types/index';

const SENTINEL = 'never-persist-workflow-secret-9ab57e';

describe('workflow execution error serialization', () => {
  test('keeps only fixed messages and allowlisted context for known failures', () => {
    const raw = new ElizaError(`upstream echoed ${SENTINEL}`, {
      code: 'WORKFLOW_HTTP_STATUS_ERROR',
      context: {
        method: 'POST',
        statusCode: 401,
        url: `https://example.test/?token=${SENTINEL}`,
        responseBodyPreview: SENTINEL,
        headers: { authorization: SENTINEL },
      },
    });

    expect(
      serializeWorkflowExecutionError(raw, {
        workflowId: 'workflow-123',
        executionId: 'execution-456',
      })
    ).toEqual({
      message: 'HTTP request failed with status 401',
      code: 'WORKFLOW_HTTP_STATUS_ERROR',
      context: {
        workflowId: 'workflow-123',
        executionId: 'execution-456',
        method: 'POST',
        statusCode: 401,
      },
    });
  });

  test('replaces arbitrary thrown messages and causes instead of redacting by pattern', () => {
    const raw = new Error(`database returned ${SENTINEL}`, {
      cause: { token: SENTINEL },
    });
    const safe = toSafeWorkflowExecutionError(raw, {
      fallbackCode: 'WORKFLOW_NODE_EXECUTION_FAILED',
    });

    expect(safe.message).toBe('Workflow node execution failed');
    expect(safe.code).toBe('WORKFLOW_NODE_EXECUTION_FAILED');
    expect(safe.cause).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain(SENTINEL);
    expect(safe.stack).not.toContain(SENTINEL);
  });

  test('does not accept prototype properties or caller-spoofed durable ids as safe fields', () => {
    for (const code of ['__proto__', 'constructor', 'toString']) {
      const safe = serializeWorkflowExecutionError({
        code,
        message: SENTINEL,
        context: {
          workflowId: SENTINEL,
          executionId: SENTINEL,
          statusCode: 502,
        },
      });
      expect(safe).toEqual({
        message: 'Workflow execution failed',
        code: 'WORKFLOW_EXECUTION_FAILED',
        context: { statusCode: 502 },
      });
      expect(JSON.stringify(safe)).not.toContain(SENTINEL);
    }
  });

  test('retains fixed operational codes without reflecting configuration values', () => {
    const raw = new ElizaError(`postgres URL contained ${SENTINEL}`, {
      code: 'SMITHERS_DB_URL_REQUIRED',
      context: {
        provider: SENTINEL,
        connectionString: `postgres://${SENTINEL}@example.test/db`,
      },
    });

    expect(serializeWorkflowExecutionError(raw)).toEqual({
      message: 'Smithers PostgreSQL configuration is incomplete',
      code: 'SMITHERS_DB_URL_REQUIRED',
    });
  });

  test('normalizes historical persisted errors before an execution is returned', () => {
    const historical: WorkflowExecution = {
      id: 'execution-old',
      workflowId: 'workflow-old',
      finished: true,
      mode: 'manual',
      status: 'error',
      startedAt: '2026-07-21T00:00:00.000Z',
      stoppedAt: '2026-07-21T00:00:01.000Z',
      data: {
        resultData: {
          error: {
            message: SENTINEL,
            stack: `Error: ${SENTINEL}`,
            code: 'WORKFLOW_HTTP_STATUS_ERROR',
            context: { statusCode: 503, responseBodyPreview: SENTINEL },
          },
        },
      },
    };

    const safe = sanitizeWorkflowExecution(historical);
    expect(safe.data?.resultData?.error).toEqual({
      message: 'HTTP request failed with status 503',
      code: 'WORKFLOW_HTTP_STATUS_ERROR',
      context: {
        workflowId: 'workflow-old',
        executionId: 'execution-old',
        statusCode: 503,
      },
    });
    expect(JSON.stringify(safe.data?.resultData?.error)).not.toContain(SENTINEL);
  });
});
