/** Verifies conversation flattening and immutable owner tags used by workflow boundaries. */
import { afterEach, describe, expect, test } from 'bun:test';
import { AgentRuntime, createCharacter, stringToUuid } from '@elizaos/core';
import {
  buildConversationContext,
  getAttestedCloudWorkflowPrincipal,
  getUserTagName,
  isPotentialLegacyUserTag,
} from '../../src/utils/context';
import { createMockMessage, createMockState } from '../helpers/mockRuntime';

const AGENT_ID = stringToUuid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const INITIAL_CLOUD_PROVISIONED = process.env.ELIZA_CLOUD_PROVISIONED;

afterEach(() => {
  if (INITIAL_CLOUD_PROVISIONED === undefined) delete process.env.ELIZA_CLOUD_PROVISIONED;
  else process.env.ELIZA_CLOUD_PROVISIONED = INITIAL_CLOUD_PROVISIONED;
});

function runtime(entityName = 'Owner'): AgentRuntime {
  return Object.assign(
    new AgentRuntime({
      agentId: AGENT_ID,
      character: createCharacter({ id: AGENT_ID, name: 'Workflow owner-tag test agent' }),
      enableAutonomy: false,
      logLevel: 'fatal',
    }),
    {
      getEntityById: async () => ({ names: [entityName] }),
    }
  );
}

describe('buildConversationContext', () => {
  test('returns message text when no recent messages in values', () => {
    const message = createMockMessage({
      content: { text: 'Activate my workflow' },
    });
    const state = createMockState();

    const result = buildConversationContext(message, state);
    expect(result).toBe('Activate my workflow');
  });

  test('returns empty string when no text and no recent messages', () => {
    const message = createMockMessage({ content: { text: '' } });
    const state = createMockState();

    const result = buildConversationContext(message, state);
    expect(result).toBe('');
  });

  test('handles undefined state', () => {
    const message = createMockMessage({ content: { text: 'Hello' } });

    const result = buildConversationContext(message, undefined);
    expect(result).toBe('Hello');
  });

  test('appends current request to recentMessages', () => {
    const message = createMockMessage({ content: { text: 'Activate it' } });
    const state = createMockState({
      values: {
        recentMessages:
          'User: Show me my workflows\nAssistant: Here are your workflows: Stripe, Gmail',
      },
    });

    const result = buildConversationContext(message, state);
    expect(result).toContain('User: Show me my workflows');
    expect(result).toContain('Assistant: Here are your workflows');
    expect(result).toContain('Current request: Activate it');
  });

  test('preserves recentMessages formatting from provider', () => {
    const message = createMockMessage({ content: { text: 'Do something' } });
    const preformattedMessages = `[2024-01-01 10:00] Alice: Hello
[2024-01-01 10:01] Bot: Hi there!
[2024-01-01 10:02] Alice: Help me`;

    const state = createMockState({
      values: { recentMessages: preformattedMessages },
    });

    const result = buildConversationContext(message, state);
    expect(result).toBe(`${preformattedMessages}\n\nCurrent request: Do something`);
  });
});

describe('workflow owner tags', () => {
  test('encodes the complete immutable owner and agent identities', async () => {
    await expect(getUserTagName(runtime(), '11111111-1111-4111-8111-111111111111')).resolves.toBe(
      'eliza_owner_11111111111141118111111111111111_agent_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'
    );
  });

  test('does not collide when owner UUIDs share the same leading segment', async () => {
    const first = await getUserTagName(runtime(), '12345678-0000-4000-8000-000000000001');
    const second = await getUserTagName(runtime(), '12345678-0000-4000-8000-000000000002');

    expect(first).not.toBe(second);
  });

  test('does not change when the owner display name is renamed', async () => {
    const ownerId = '12345678-0000-4000-8000-000000000001';
    const beforeRename = await getUserTagName(runtime('Original Name'), ownerId);
    const afterRename = await getUserTagName(runtime('Renamed Owner'), ownerId);

    expect(afterRename).toBe(beforeRename);
  });

  test('recognizes the prior truncated tag only as migration evidence for the same owner and agent', () => {
    const ownerId = '12345678-0000-4000-8000-000000000001';
    expect(
      isPotentialLegacyUserTag(
        runtime(),
        ownerId,
        'Renamed Owner_12345678_agent_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'
      )
    ).toBe(true);
    expect(
      isPotentialLegacyUserTag(
        runtime(),
        '87654321-0000-4000-8000-000000000001',
        'Renamed Owner_12345678_agent_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'
      )
    ).toBe(false);
  });
});

describe('managed Cloud workflow principal attestation', () => {
  test('recognizes a matching attested tenant when provisioning uses true', () => {
    process.env.ELIZA_CLOUD_PROVISIONED = 'true';
    const ownerId = stringToUuid('managed-cloud-workflow-owner');
    const message = createMockMessage({
      entityId: ownerId,
      content: {
        text: 'Create my workflow',
        metadata: {
          elizaCloudPrincipal: { id: ownerId, attested: true },
        },
      },
    });

    expect(getAttestedCloudWorkflowPrincipal(message)).toBe(ownerId);
  });

  test('rejects a foreign attestation instead of crossing tenant scope', () => {
    process.env.ELIZA_CLOUD_PROVISIONED = 'true';
    const ownerId = stringToUuid('managed-cloud-workflow-owner');
    const foreignOwnerId = stringToUuid('managed-cloud-workflow-foreign-owner');
    const message = createMockMessage({
      entityId: ownerId,
      content: {
        text: 'Create my workflow',
        metadata: {
          elizaCloudPrincipal: { id: foreignOwnerId, attested: true },
        },
      },
    });

    expect(getAttestedCloudWorkflowPrincipal(message)).toBeNull();
  });
});
