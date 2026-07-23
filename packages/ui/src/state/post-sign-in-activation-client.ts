/**
 * Retrieves the durable post-sign-in activation across startup and network
 * races, recovering a committed-but-unacknowledged response from transcript.
 */

import { isApiError } from "../api";
import type {
  ConversationGreeting,
  ConversationMessage,
} from "../api/client-types-chat";

export interface PostSignInActivationClient {
  getStatus(): Promise<{ state: string }>;
  requestGreeting(
    conversationId: string,
    language: string,
    kind: "post_sign_in_activation",
  ): Promise<ConversationGreeting>;
  getConversationMessages(
    conversationId: string,
    options?: { around?: string },
  ): Promise<{ messages: ConversationMessage[] }>;
}

export interface PostSignInActivationRetryOptions {
  client: PostSignInActivationClient;
  conversationId: string;
  language: string;
  sleep?: (delayMs: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isRetryableActivationError(error: unknown): boolean {
  if (!isApiError(error)) return true;
  if (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "parse"
  ) {
    return true;
  }
  const status = error.status;
  return (
    status === 202 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
}

function recoveredGreeting(
  greeting: ConversationGreeting,
  message: ConversationMessage,
): ConversationGreeting {
  return {
    ...greeting,
    text: message.text,
    messageId: message.id,
    timestamp: message.timestamp,
    source: message.source ?? greeting.source,
    greetingKind: message.greetingKind ?? greeting.greetingKind,
    activationVersion: message.activationVersion ?? greeting.activationVersion,
  };
}

/**
 * Returns the activation response, or a recovered copy of its persisted
 * transcript row. A response pointing at a different winning conversation is
 * a terminal no-op; a same-conversation row that is not yet readable retries.
 */
export async function requestPostSignInActivationWithRetry(
  options: PostSignInActivationRetryOptions,
): Promise<ConversationGreeting> {
  const sleep = options.sleep ?? defaultSleep;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(retryDelays[attempt - 1] ?? 0);
    }

    try {
      const status = await options.client.getStatus();
      if (status.state !== "running") {
        lastError = new Error(
          `Agent is ${status.state || "not running"}; activation is waiting for readiness`,
        );
        continue;
      }

      const greeting = await options.client.requestGreeting(
        options.conversationId,
        options.language,
        "post_sign_in_activation",
      );
      if (greeting.text.trim().length > 0) return greeting;

      if (
        greeting.conversationId &&
        greeting.conversationId !== options.conversationId
      ) {
        return greeting;
      }
      if (!greeting.messageId) return greeting;

      const transcript = await options.client.getConversationMessages(
        options.conversationId,
        { around: greeting.messageId },
      );
      const persisted = transcript.messages.find(
        (message) =>
          message.id === greeting.messageId &&
          message.role === "assistant" &&
          message.greetingKind === "post_sign_in_activation" &&
          message.text.trim().length > 0,
      );
      if (persisted) return recoveredGreeting(greeting, persisted);

      lastError = new Error(
        "Post-sign-in activation was committed but is not readable from its winning conversation",
      );
    } catch (error) {
      if (!isRetryableActivationError(error)) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Post-sign-in activation could not be loaded");
}
