/**
 * Conversation-context helpers for workflow actions. Ownership tags encode the
 * complete immutable owner and agent identities so renames and shared-backend
 * tenants cannot change or collide with authorization state.
 */
import {
  type IAgentRuntime,
  type Memory,
  resolveCanonicalOwnerId,
  type State,
  stringToUuid,
} from '@elizaos/core';

/**
 * Resolve the single local owner identity shared by app routes and client chat.
 * Legacy plugin-route headers cannot supply this value because they are
 * caller-controlled; a trusted dispatcher can still pass a different
 * principal explicitly at its boundary.
 */
export function getLocalOwnerEntityId(runtime: IAgentRuntime): string {
  const canonicalOwnerId = resolveCanonicalOwnerId(runtime);
  if (typeof canonicalOwnerId === 'string' && canonicalOwnerId.trim()) {
    return canonicalOwnerId.trim();
  }

  const agentName = runtime.character?.name?.trim() || 'Eliza';
  return stringToUuid(`${agentName}-admin-entity`);
}

export function buildConversationContext(message: Memory, state: State | undefined): string {
  const raw = state?.values?.recentMessages;
  const recentMessages = typeof raw === 'string' ? raw : '';
  const currentText = message.content.text ?? '';

  if (!recentMessages) {
    return currentText;
  }

  return `${recentMessages}\n\nCurrent request: ${currentText}`;
}

export async function getUserTagName(runtime: IAgentRuntime, userId: string): Promise<string> {
  const ownerScopeId = stringToUuid(userId.trim()).replace(/-/g, '');
  const agentScopeId = stringToUuid(runtime.agentId).replace(/-/g, '');
  return `eliza_owner_${ownerScopeId}_agent_${agentScopeId}`;
}

/**
 * Detects the previous display-name + truncated-owner tag shape for this exact
 * agent and owner candidate. A match is migration evidence only: the truncated
 * owner segment is never sufficient authorization to read a workflow.
 */
export function isPotentialLegacyUserTag(
  runtime: IAgentRuntime,
  userId: string,
  tagName: string
): boolean {
  const ownerPrefix = userId.trim().replace(/-/g, '').slice(0, 8);
  const agentScopeId = runtime.agentId.replace(/-/g, '');
  if (!ownerPrefix || !agentScopeId) return false;
  return tagName.endsWith(`_${ownerPrefix}_agent_${agentScopeId}`);
}
