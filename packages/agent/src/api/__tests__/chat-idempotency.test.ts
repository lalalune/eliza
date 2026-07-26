/**
 * Pins the HTTP chat idempotency contract used by both conversation send
 * transports. Active requests remain protected regardless of generation time;
 * completed receipts age out so the in-memory index stays bounded.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __getChatDedupeTtlMsForTests,
  __resetChatDedupeForTests,
  isDuplicateChatMessage,
  normalizeClientMessageId,
  recordChatMessageReceipt,
} from "../chat-routes.ts";

const OLD_ARRIVAL_TTL_MS = 30_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const RECONNECT_WAIT_TIMEOUT_MS = 30_000;
const RECONNECT_SIGNAL_DEBOUNCE_MS = 400;
const TTL_MS = __getChatDedupeTtlMsForTests();
const SCOPE = "room-a";

afterEach(() => {
  __resetChatDedupeForTests();
});

describe("normalizeClientMessageId", () => {
  it("accepts a non-empty trimmed string", () => {
    expect(normalizeClientMessageId("abc123")).toBe("abc123");
    expect(normalizeClientMessageId("  spaced  ")).toBe("spaced");
  });

  it("rejects absent / non-string / empty values", () => {
    expect(normalizeClientMessageId(undefined)).toBeNull();
    expect(normalizeClientMessageId(null)).toBeNull();
    expect(normalizeClientMessageId("")).toBeNull();
    expect(normalizeClientMessageId("   ")).toBeNull();
    expect(normalizeClientMessageId(42)).toBeNull();
    expect(normalizeClientMessageId({ id: "x" })).toBeNull();
  });

  it("rejects an over-length key (>128 chars) as malformed/abusive", () => {
    expect(normalizeClientMessageId("x".repeat(128))).toBe("x".repeat(128));
    expect(normalizeClientMessageId("x".repeat(129))).toBeNull();
  });
});

describe("isDuplicateChatMessage", () => {
  it("never treats an absent idempotency key as a duplicate", () => {
    const now = 1_000_000;
    // Same null key, same scope, same instant — still not a duplicate, ever.
    expect(isDuplicateChatMessage(SCOPE, null, now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, null, now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, null, now + 1)).toBe(false);
  });

  it("treats a first sighting as new and a repeat within TTL as duplicate", () => {
    const now = 2_000_000;
    expect(isDuplicateChatMessage(SCOPE, "msg-1", now)).toBe(false);
    // Immediate replay and a replay near the TTL boundary are both duplicates.
    expect(isDuplicateChatMessage(SCOPE, "msg-1", now)).toBe(true);
    expect(isDuplicateChatMessage(SCOPE, "msg-1", now + TTL_MS)).toBe(true);
  });

  it("does not suppress a different idempotency key in the same scope", () => {
    const now = 3_000_000;
    expect(isDuplicateChatMessage(SCOPE, "msg-a", now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, "msg-b", now)).toBe(false);
    // Each id is independently deduped.
    expect(isDuplicateChatMessage(SCOPE, "msg-a", now)).toBe(true);
    expect(isDuplicateChatMessage(SCOPE, "msg-b", now)).toBe(true);
  });

  it("covers the long-turn reconnect retry window that exceeded the old 30s arrival TTL", () => {
    const now = 3_500_000;
    const retryAfterLongTurn =
      DEFAULT_GENERATION_TIMEOUT_MS +
      RECONNECT_WAIT_TIMEOUT_MS +
      RECONNECT_SIGNAL_DEBOUNCE_MS;

    expect(isDuplicateChatMessage(SCOPE, "msg-long-turn", now)).toBe(false);
    expect(retryAfterLongTurn).toBeGreaterThan(OLD_ARRIVAL_TTL_MS);
    expect(
      isDuplicateChatMessage(SCOPE, "msg-long-turn", now + retryAfterLongTurn),
    ).toBe(true);
  });

  it("keeps an in-flight id protected after the completed-receipt TTL", () => {
    const now = 4_000_000;
    expect(isDuplicateChatMessage(SCOPE, "msg-ttl", now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, "msg-ttl", now + TTL_MS + 1)).toBe(
      true,
    );
  });

  it("ages out a completed receipt after the TTL", () => {
    const now = 4_500_000;
    expect(isDuplicateChatMessage(SCOPE, "msg-complete", now)).toBe(false);
    recordChatMessageReceipt(
      SCOPE,
      "msg-complete",
      "json",
      { text: "done" },
      now,
    );

    expect(isDuplicateChatMessage(SCOPE, "msg-complete", now + TTL_MS)).toBe(
      true,
    );
    expect(
      isDuplicateChatMessage(SCOPE, "msg-complete", now + TTL_MS + 1),
    ).toBe(false);
  });

  it("scopes the key per conversation/user — same id in a different scope is new", () => {
    const now = 5_000_000;
    expect(isDuplicateChatMessage("room-x", "shared-id", now)).toBe(false);
    // Identical id, different scope → not a duplicate.
    expect(isDuplicateChatMessage("room-y", "shared-id", now)).toBe(false);
    // Each scope deduplicates independently.
    expect(isDuplicateChatMessage("room-x", "shared-id", now)).toBe(true);
    expect(isDuplicateChatMessage("room-y", "shared-id", now)).toBe(true);
  });

  it("evicts expired entries so the cache stays bounded", () => {
    const start = 6_000_000;
    expect(isDuplicateChatMessage(SCOPE, "old", start)).toBe(false);
    recordChatMessageReceipt(
      SCOPE,
      "old",
      "stream",
      { type: "done", fullText: "done" },
      start,
    );
    expect(
      isDuplicateChatMessage(SCOPE, "trigger-sweep", start + TTL_MS + 1),
    ).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, "old", start + TTL_MS + 2)).toBe(
      false,
    );
  });
});
