/**
 * Persists the one-time owner activation message shown after authentication.
 *
 * A deterministic message id arbitrates concurrent processes while a durable
 * cache ledger preserves completion even if the winning conversation is later
 * deleted. The process-local promise only removes duplicate work; correctness
 * comes from the shared memory id and persisted ledger.
 */

import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  ElizaError,
  MESSAGE_SOURCE_AGENT_GREETING,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  type ConversationGreetingKind,
  POST_SIGN_IN_ACTIVATION_GREETING,
  POST_SIGN_IN_ACTIVATION_VERSION,
} from "@elizaos/shared";
import { persistConversationMemoryOnce } from "./chat-routes.ts";

interface PostSignInActivationLedger {
  schemaVersion: 1;
  activationVersion: typeof POST_SIGN_IN_ACTIVATION_VERSION;
  agentId: UUID;
  ownerId: UUID;
  conversationId: string;
  roomId: UUID;
  messageId: UUID;
  createdAt: number;
}

export interface StoredConversationGreeting {
  text: string;
  agentName: string;
  generated: boolean;
  persisted: boolean;
  messageId?: string;
  source?: typeof MESSAGE_SOURCE_AGENT_GREETING;
  timestamp?: number;
  greetingKind: ConversationGreetingKind;
  activationVersion?: typeof POST_SIGN_IN_ACTIVATION_VERSION;
  conversationId?: string;
}

interface EnsurePostSignInActivationParams {
  runtime: AgentRuntime;
  ownerId: UUID;
  conversationId: string;
  roomId: UUID;
}

interface EnsuredLedger {
  ledger: PostSignInActivationLedger;
  persisted: boolean;
}

const activationEnsureInFlight = new Map<string, Promise<EnsuredLedger>>();

function activationMessageId(agentId: UUID, ownerId: UUID): UUID {
  return stringToUuid(
    `post-sign-in-activation:${agentId}:${ownerId}:${POST_SIGN_IN_ACTIVATION_VERSION}`,
  );
}

function activationLedgerKey(agentId: UUID, ownerId: UUID): string {
  return `conversation:post-sign-in-activation:${agentId}:${ownerId}:v${POST_SIGN_IN_ACTIVATION_VERSION}`;
}

function parseLedger(
  value: unknown,
  expected: { agentId: UUID; ownerId: UUID; messageId: UUID },
): PostSignInActivationLedger | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ElizaError("Post-sign-in activation ledger is malformed", {
      code: "ACTIVATION_LEDGER_CORRUPT",
      context: { agentId: expected.agentId, ownerId: expected.ownerId },
      severity: "fatal",
    });
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.activationVersion !== POST_SIGN_IN_ACTIVATION_VERSION ||
    record.agentId !== expected.agentId ||
    record.ownerId !== expected.ownerId ||
    record.messageId !== expected.messageId ||
    typeof record.conversationId !== "string" ||
    record.conversationId.length === 0 ||
    typeof record.roomId !== "string" ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt)
  ) {
    throw new ElizaError("Post-sign-in activation ledger is inconsistent", {
      code: "ACTIVATION_LEDGER_CORRUPT",
      context: { agentId: expected.agentId, ownerId: expected.ownerId },
      severity: "fatal",
    });
  }
  return record as unknown as PostSignInActivationLedger;
}

function ledgerFromMemory(
  runtime: AgentRuntime,
  ownerId: UUID,
  messageId: UUID,
  memory: NonNullable<Awaited<ReturnType<AgentRuntime["getMemoryById"]>>>,
): PostSignInActivationLedger {
  const content = memory.content as Record<string, unknown>;
  if (
    memory.id !== messageId ||
    memory.entityId !== runtime.agentId ||
    content.source !== MESSAGE_SOURCE_AGENT_GREETING ||
    content.greetingKind !== "post_sign_in_activation" ||
    content.activationVersion !== POST_SIGN_IN_ACTIVATION_VERSION ||
    content.activationOwnerId !== ownerId ||
    typeof content.activationConversationId !== "string" ||
    content.activationConversationId.length === 0 ||
    typeof memory.createdAt !== "number" ||
    !Number.isFinite(memory.createdAt)
  ) {
    throw new ElizaError(
      "Deterministic post-sign-in activation memory is inconsistent",
      {
        code: "ACTIVATION_MEMORY_CORRUPT",
        context: {
          agentId: runtime.agentId,
          ownerId,
          messageId,
        },
        severity: "fatal",
      },
    );
  }
  return {
    schemaVersion: 1,
    activationVersion: POST_SIGN_IN_ACTIVATION_VERSION,
    agentId: runtime.agentId,
    ownerId,
    conversationId: content.activationConversationId,
    roomId: memory.roomId,
    messageId,
    createdAt: memory.createdAt,
  };
}

async function ensureActivationLedgerUnlocked(
  params: EnsurePostSignInActivationParams,
): Promise<EnsuredLedger> {
  const { runtime, ownerId, conversationId, roomId } = params;
  const messageId = activationMessageId(runtime.agentId, ownerId);
  const cacheKey = activationLedgerKey(runtime.agentId, ownerId);
  const cached = parseLedger(await runtime.getCache(cacheKey), {
    agentId: runtime.agentId,
    ownerId,
    messageId,
  });
  if (cached) {
    return { ledger: cached, persisted: false };
  }

  const existingMemory = await runtime.getMemoryById(messageId);
  if (existingMemory) {
    const ledger = ledgerFromMemory(
      runtime,
      ownerId,
      messageId,
      existingMemory,
    );
    await runtime.setCache(cacheKey, ledger);
    return { ledger, persisted: false };
  }

  const candidate = createMessageMemory({
    id: messageId,
    entityId: runtime.agentId,
    roomId,
    content: {
      text: POST_SIGN_IN_ACTIVATION_GREETING,
      source: MESSAGE_SOURCE_AGENT_GREETING,
      channelType: ChannelType.DM,
      greetingKind: "post_sign_in_activation",
      activationVersion: POST_SIGN_IN_ACTIVATION_VERSION,
      activationOwnerId: ownerId,
      activationConversationId: conversationId,
    },
  });
  const inserted = await persistConversationMemoryOnce(runtime, candidate);

  const stored = await runtime.getMemoryById(messageId);
  if (!stored) {
    throw new ElizaError(
      "Post-sign-in activation memory was not readable after persistence",
      {
        code: "ACTIVATION_MEMORY_NOT_PERSISTED",
        context: { agentId: runtime.agentId, ownerId, messageId },
        severity: "fatal",
      },
    );
  }
  const ledger = ledgerFromMemory(runtime, ownerId, messageId, stored);
  await runtime.setCache(cacheKey, ledger);
  return {
    ledger,
    persisted:
      inserted &&
      stored.roomId === candidate.roomId &&
      stored.createdAt === candidate.createdAt,
  };
}

async function renderActivationForConversation(
  runtime: AgentRuntime,
  targetConversationId: string,
  ensured: EnsuredLedger,
): Promise<StoredConversationGreeting> {
  const { ledger } = ensured;
  const memory = await runtime.getMemoryById(ledger.messageId);
  const isWinningConversation =
    ledger.conversationId === targetConversationId && memory !== null;
  const shouldDeliver = isWinningConversation && ensured.persisted;
  return {
    text: shouldDeliver ? POST_SIGN_IN_ACTIVATION_GREETING : "",
    agentName: runtime.character.name ?? "Eliza",
    generated: shouldDeliver,
    persisted: shouldDeliver,
    messageId: ledger.messageId,
    source: MESSAGE_SOURCE_AGENT_GREETING,
    timestamp: ledger.createdAt,
    greetingKind: "post_sign_in_activation",
    activationVersion: POST_SIGN_IN_ACTIVATION_VERSION,
    conversationId: ledger.conversationId,
  };
}

export async function ensurePostSignInActivation(
  params: EnsurePostSignInActivationParams,
): Promise<StoredConversationGreeting> {
  const cacheKey = activationLedgerKey(params.runtime.agentId, params.ownerId);
  const existing = activationEnsureInFlight.get(cacheKey);
  if (existing) {
    return renderActivationForConversation(
      params.runtime,
      params.conversationId,
      {
        ledger: (await existing).ledger,
        persisted: false,
      },
    );
  }

  const run = ensureActivationLedgerUnlocked(params);
  activationEnsureInFlight.set(cacheKey, run);
  try {
    return renderActivationForConversation(
      params.runtime,
      params.conversationId,
      await run,
    );
  } finally {
    activationEnsureInFlight.delete(cacheKey);
  }
}
