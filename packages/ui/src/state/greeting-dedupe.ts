/**
 * Single-greeting invariant for a conversation thread.
 *
 * A conversation may only ever carry ONE agent-greeting bubble. Two independent
 * seeding paths can each land a greeting for a fresh thread:
 *
 *  1. the inline greeting returned by `createConversation({ bootstrapGreeting })`,
 *     which SETS the thread to `[greeting]`, and
 *  2. the fallback `client.requestGreeting()` fetch (used when the inline
 *     greeting is absent — old server — or when the empty-thread auto-greet
 *     effect fires), which APPENDS a greeting.
 *
 * The server greeting is `pickRandom(postExamples)` when no persisted greeting
 * exists yet, so a race between the two paths (the fallback firing before the
 * inline greeting's server-side persist commits) can produce two greetings with
 * DIFFERENT text. A text-equality dedupe then lets both through and the thread
 * shows a duplicated "Hey, I'm …" bubble (the device-review defect).
 *
 * The invariant is therefore by SOURCE + KIND, not text: at most one ordinary
 * conversation greeting and one account-activation greeting survive. The
 * activation is a separate durable product event and must not be swallowed by
 * a legacy hello that happened to land first.
 */
import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";
import type { ConversationMessage } from "../api";

/** Whether a message is an agent-greeting bubble. */
export function isAgentGreetingMessage(message: ConversationMessage): boolean {
  return (
    message.role === "assistant" &&
    message.source === MESSAGE_SOURCE_AGENT_GREETING
  );
}

function greetingIdentity(message: ConversationMessage): string {
  return message.greetingKind ?? "conversation";
}

/**
 * Collapse a message list to one greeting per semantic kind, keeping the first
 * of each kind and every non-greeting message in order.
 */
export function dedupeGreetings(
  messages: ConversationMessage[],
): ConversationMessage[] {
  const seenGreetings = new Set<string>();
  let duplicateFound = false;
  for (const message of messages) {
    if (!isAgentGreetingMessage(message)) continue;
    const identity = greetingIdentity(message);
    if (seenGreetings.has(identity)) {
      duplicateFound = true;
      break;
    }
    seenGreetings.add(identity);
  }
  if (!duplicateFound) return messages;

  const kept = new Set<string>();
  return messages.filter((message) => {
    if (!isAgentGreetingMessage(message)) return true;
    const identity = greetingIdentity(message);
    if (kept.has(identity)) return false;
    kept.add(identity);
    return true;
  });
}

/**
 * Append a greeting to a thread while preserving the single-greeting invariant:
 * if the thread already carries a greeting bubble, the incoming one is dropped
 * (the earliest greeting wins), so a fallback fetch that lands after an inline
 * greeting never double-seeds. Returns the same reference when nothing changes.
 */
export function appendGreetingOnce(
  messages: ConversationMessage[],
  greeting: ConversationMessage,
): ConversationMessage[] {
  const incomingIdentity = greetingIdentity(greeting);
  if (
    messages.some(
      (message) =>
        isAgentGreetingMessage(message) &&
        greetingIdentity(message) === incomingIdentity,
    )
  ) {
    return messages;
  }
  return [...messages, greeting];
}
