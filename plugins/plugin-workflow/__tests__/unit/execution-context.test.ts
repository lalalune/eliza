/** Verifies durable workflow execution routing metadata is normalized and cannot be spoofed. */
import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition } from '../../src/types/index';
import {
  readWorkflowExecutionContext,
  WORKFLOW_EXECUTION_CONTEXT_META_KEY,
  withWorkflowExecutionContext,
} from '../../src/utils/context';

function workflow(meta?: Record<string, unknown>): WorkflowDefinition {
  return { name: 'Context test', nodes: [], connections: {}, meta };
}

describe('workflow execution context metadata', () => {
  test('replaces caller-supplied routing fields with server-resolved values', () => {
    const incoming = workflow({
      retained: 'yes',
      [WORKFLOW_EXECUTION_CONTEXT_META_KEY]: {
        ownerEntityId: 'spoofed-owner',
        sourceRoomId: 'spoofed-room',
      },
    });

    const stamped = withWorkflowExecutionContext(incoming, {
      ownerEntityId: 'trusted-owner',
      sourceRoomId: 'trusted-room',
    });

    expect(readWorkflowExecutionContext(stamped)).toEqual({
      ownerEntityId: 'trusted-owner',
      sourceRoomId: 'trusted-room',
    });
    expect(stamped.meta?.retained).toBe('yes');
  });

  test('ignores malformed and blank persisted routing fields', () => {
    expect(
      readWorkflowExecutionContext(
        workflow({
          [WORKFLOW_EXECUTION_CONTEXT_META_KEY]: {
            ownerEntityId: '   ',
            sourceRoomId: 42,
          },
        })
      )
    ).toBeUndefined();
  });
});
