/**
 * Verifies the anonymous admission client keeps authoritative hydration and
 * counter persistence in `waitUntil` while warm identity reads stay DB-free.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { AnonymousChatGate } from "../src/anonymous-chat-gate";

const getGateHydrationByToken = mock(async () => ({
  sessionId: "session-a",
  userId: "user-a",
  messageCount: 0,
  messagesLimit: 10,
  hourlyMessageCount: 0,
  hourlyResetAt: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  gateRevision: 0,
}));
const persistGateCounterSnapshot = mock(async () => true);

mock.module("@/db/repositories/anonymous-sessions", () => ({
  anonymousSessionsRepository: {
    getGateHydrationByToken,
    persistGateCounterSnapshot,
  },
}));
mock.module("@/lib/services/content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser: mock(async () => false),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock() },
}));

const {
  refundAnonymousChatSlot,
  reserveAnonymousChatSlot,
  resolveAnonymousChatContext,
} = await import("@/lib/services/anonymous-chat-admission");

class TestStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

function createBindings(gate: AnonymousChatGate) {
  return {
    ANONYMOUS_CHAT_GATES: {
      getByName(name: string) {
        expect(name).not.toContain("secret-session-token");
        return {
          fetch: (request: RequestInfo | URL, init?: RequestInit) =>
            gate.fetch(new Request(request, init)),
        };
      },
    },
  };
}

beforeEach(() => {
  getGateHydrationByToken.mockClear();
  persistGateCounterSnapshot.mockClear();
});

describe("anonymous chat admission client", () => {
  test("hydrates cold state off-path, then leases and mirrors counters off-path", async () => {
    const gate = new AnonymousChatGate(
      { storage: new TestStorage() } as unknown as DurableObjectState,
      {} as never,
    );
    const waitUntilTasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
    };
    const request = new Request("https://api.test/api/v1/chat", {
      headers: {
        cookie: "eliza-anon-session=secret-session-token",
      },
    });

    await runWithCloudBindingsAsync(createBindings(gate), async () => {
      expect(await resolveAnonymousChatContext(request, executionCtx)).toEqual({
        kind: "warming",
      });
      expect(waitUntilTasks).toHaveLength(1);
      await Promise.all(waitUntilTasks.splice(0));

      const warm = await resolveAnonymousChatContext(request, executionCtx);
      expect(warm).toMatchObject({
        kind: "ready",
        blocked: false,
        credential: {
          context: {
            sessionId: "session-a",
            userId: "user-a",
            messageCount: 0,
          },
        },
      });
      expect(getGateHydrationByToken).toHaveBeenCalledTimes(1);

      if (warm.kind !== "ready") throw new Error("expected warm context");
      const lease = await reserveAnonymousChatSlot(
        warm.credential,
        "request-a",
        executionCtx,
      );
      expect(lease).toMatchObject({
        kind: "admitted",
        remaining: 9,
        limit: 10,
      });
      expect(waitUntilTasks).toHaveLength(1);
      await Promise.all(waitUntilTasks.splice(0));
      expect(persistGateCounterSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-a",
          revision: 1,
          messageCount: 1,
        }),
      );

      if (lease.kind !== "admitted") throw new Error("expected lease");
      await refundAnonymousChatSlot(lease.lease, executionCtx);
      await refundAnonymousChatSlot(lease.lease, executionCtx);
      await Promise.all(waitUntilTasks.splice(0));
      expect(persistGateCounterSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "session-a",
          revision: 2,
          messageCount: 0,
        }),
      );
    });
  });
});
