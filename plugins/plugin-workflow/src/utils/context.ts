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
import type { WorkflowDefinition, WorkflowExecutionContext } from '../types/index';

export const WORKFLOW_EXECUTION_CONTEXT_META_KEY = 'elizaExecutionContext';

const CANONICAL_WORKFLOW_OWNER_TAG_PATTERN =
  /^eliza_owner_([0-9a-f]{32})_agent_([0-9a-f]{32})$/;

function isEnabledSetting(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase()))
  );
}

/** Managed Cloud accepts the same boolean-like provisioning values at every
 * workflow ownership boundary, including white-label aliases. */
export function isManagedCloudEnvironment(): boolean {
  const provisioned = readAliasedEnv('ELIZA_CLOUD_PROVISIONED');
  return isEnabledSetting(provisioned);
}

/** Runtime settings are used by tests and embedded hosts that do not project
 * character configuration into process env. Either trusted source marks the
 * workflow boundary as managed Cloud. */
export function isManagedCloudRuntime(runtime: Pick<IAgentRuntime, 'getSetting'>): boolean {
  return (
    isEnabledSetting(runtime.getSetting?.('ELIZA_CLOUD_PROVISIONED')) ||
    isManagedCloudEnvironment()
  );
}

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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Read only the routing fields the execution boundary understands. */
export function readWorkflowExecutionContext(
  workflow: Pick<WorkflowDefinition, 'meta'>
): WorkflowExecutionContext | undefined {
  const metadata = asRecord(workflow.meta);
  const stored = asRecord(metadata?.[WORKFLOW_EXECUTION_CONTEXT_META_KEY]);
  if (!stored) return undefined;
  const ownerEntityId = nonEmptyString(stored.ownerEntityId);
  const sourceRoomId = nonEmptyString(stored.sourceRoomId);
  return ownerEntityId || sourceRoomId ? { ownerEntityId, sourceRoomId } : undefined;
}

/** Replace the reserved routing metadata with server-resolved values so an
 * incoming definition cannot spoof another owner or conversation. */
export function withWorkflowExecutionContext(
  workflow: WorkflowDefinition,
  context: WorkflowExecutionContext
): WorkflowDefinition {
  const ownerEntityId = nonEmptyString(context.ownerEntityId);
  const sourceRoomId = nonEmptyString(context.sourceRoomId);
  const currentMeta = asRecord(workflow.meta) ?? {};
  const nextMeta = { ...currentMeta };
  if (ownerEntityId || sourceRoomId) {
    nextMeta[WORKFLOW_EXECUTION_CONTEXT_META_KEY] = {
      ...(ownerEntityId ? { ownerEntityId } : {}),
      ...(sourceRoomId ? { sourceRoomId } : {}),
    };
  } else {
    delete nextMeta[WORKFLOW_EXECUTION_CONTEXT_META_KEY];
  }
  return { ...workflow, meta: nextMeta };
}

/**
 * Browser-originated Cloud messages carry a server-owned marker installed only
 * after the edge principal proof succeeds. This keeps chat workflow ownership
 * aligned with the authenticated workflow HTTP routes.
 */
export function getAttestedCloudWorkflowPrincipal(message: Memory): string | null {
  if (!isManagedCloudEnvironment()) return null;
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

export type CanonicalWorkflowOwnerTagResolution =
  | { status: 'resolved'; ownerEntityId: string }
  | { status: 'missing' | 'ambiguous' };

function expandCompactUuid(value: string): string {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Recover a legacy workflow owner only from the complete server-created tag
 * for this exact agent. Truncated display-name tags and multiple owner tags are
 * migration evidence, never authorization. */
export function resolveCanonicalWorkflowOwnerTag(
  runtime: Pick<IAgentRuntime, 'agentId'>,
  workflow: Pick<WorkflowDefinition, 'tags'>
): CanonicalWorkflowOwnerTagResolution {
  const expectedAgentScope = stringToUuid(runtime.agentId).replace(/-/g, '');
  const matchingOwners = (workflow.tags ?? []).flatMap((tag) => {
    const match = CANONICAL_WORKFLOW_OWNER_TAG_PATTERN.exec(tag.name);
    return match?.[2] === expectedAgentScope && match[1] ? [match[1]] : [];
  });
  if (matchingOwners.length === 0) return { status: 'missing' };
  if (matchingOwners.length !== 1) return { status: 'ambiguous' };
  const ownerScope = matchingOwners[0];
  if (!ownerScope) return { status: 'missing' };
  return {
    status: 'resolved',
    ownerEntityId: expandCompactUuid(ownerScope),
  };
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
