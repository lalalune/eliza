/**
 * Drives the production post-sign-in activation boundary from a scenario.
 *
 * The turn calls the same durable activation helper used by conversation
 * routes, so scenario evidence covers the stable message identity and
 * persisted greeting instead of substituting authored chat text.
 */

import type { StoredConversationGreeting } from "@elizaos/agent/api/conversation-activation";
import type { AgentRuntime, UUID } from "@elizaos/core";

type EnsurePostSignInActivation = (args: {
  runtime: AgentRuntime;
  ownerId: UUID;
  conversationId: string;
  roomId: UUID;
}) => Promise<StoredConversationGreeting>;

export interface PostSignInActivationTurnInput {
  runtime: AgentRuntime;
  ownerId: UUID;
  roomId: UUID;
  conversationId: string;
  ensureActivation?: EnsurePostSignInActivation;
}

export interface PostSignInActivationTurnResult {
  responseText: string;
  responseBody: StoredConversationGreeting;
  statusCode: 200;
  durationMs: number;
}

async function loadProductionActivationHelper(): Promise<EnsurePostSignInActivation> {
  const { ensurePostSignInActivation } = await import(
    "@elizaos/agent/api/conversation-activation"
  );
  return ensurePostSignInActivation;
}

export async function executePostSignInActivationTurn(
  input: PostSignInActivationTurnInput,
): Promise<PostSignInActivationTurnResult> {
  const startedAt = Date.now();
  const ensureActivation =
    input.ensureActivation ?? (await loadProductionActivationHelper());
  const responseBody = await ensureActivation({
    runtime: input.runtime,
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    roomId: input.roomId,
  });
  return {
    responseText: responseBody.text,
    responseBody,
    statusCode: 200,
    durationMs: Date.now() - startedAt,
  };
}
