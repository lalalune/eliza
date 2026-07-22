/**
 * Conversation-context helpers for workflow actions. Ownership tags encode the
 * complete immutable owner and agent identities so renames and shared-backend
 * tenants cannot change or collide with authorization state.
 */
import {
  type IAgentRuntime,
  type Memory,
  resolveCanonicalOwnerId,
  resolveCanonicalOwnerIdForMessage,
  type State,
  stringToUuid,
} from '@elizaos/core';
import { readAliasedEnv } from '@elizaos/shared';

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Browser-originated Cloud messages carry a server-owned marker installed only
 * after the edge principal proof succeeds. This keeps chat workflow ownership
 * aligned with the authenticated workflow HTTP routes.
 */
export function getAttestedCloudWorkflowPrincipal(message: Memory): string | null {
  if (readAliasedEnv('ELIZA_CLOUD_PROVISIONED') !== '1') return null;
  const metadata = asRecord(message.content.metadata);
  const attestation = asRecord(metadata?.elizaCloudPrincipal);
  if (attestation?.attested !== true || typeof attestation.id !== 'string') return null;
  const principalId = stringToUuid(attestation.id.trim());
  return principalId === message.entityId ? principalId : null;
}

export async function resolveWorkflowOwnerEntityId(
  runtime: IAgentRuntime,
  message: Memory
): Promise<string> {
  return (
    getAttestedCloudWorkflowPrincipal(message) ??
    (await resolveCanonicalOwnerIdForMessage(runtime, message)) ??
    getLocalOwnerEntityId(runtime)
  );
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
