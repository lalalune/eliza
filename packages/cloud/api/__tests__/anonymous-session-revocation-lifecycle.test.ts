/**
 * Proves anonymous conversion revokes the real provider-dispatch gate before persistence.
 *
 * The database mutation is represented by a callback so the test can inspect
 * the exact linearization point while the identity, lease, and dispatch state
 * use the production Durable Object implementation.
 */

import { describe, expect, mock, test } from "bun:test";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { persistAnonymousSessionRestriction } from "@/lib/services/anonymous-session-lifecycle";
import { AnonymousChatGate } from "../src/anonymous-chat-gate";

class TestStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | undefined;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async transaction<T>(
    closure: (transaction: {
      put(key: string, value: unknown): Promise<void>;
      setAlarm(scheduledTime: number): Promise<void>;
      deleteAlarm(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const stagedValues = new Map(this.values);
    let stagedAlarm = this.alarm;
    const result = await closure({
      put: async (key, value) => {
        stagedValues.set(key, structuredClone(value));
      },
      setAlarm: async (scheduledTime) => {
        stagedAlarm = scheduledTime;
      },
      deleteAlarm: async () => {
        stagedAlarm = undefined;
      },
    });
    this.values.clear();
    for (const [key, value] of stagedValues) {
      this.values.set(key, value);
    }
    this.alarm = stagedAlarm;
    return result;
  }
}

function post(
  gate: AnonymousChatGate,
  path: "/hydrate" | "/lease" | "/dispatch",
  body: Record<string, unknown>,
): Promise<Response> {
  return gate.fetch(
    new Request(`https://anonymous-chat-gate${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function bindingsFor(gate: AnonymousChatGate) {
  return {
    ANONYMOUS_CHAT_GATES: {
      getByName() {
        return {
          fetch(request: RequestInfo | URL, init?: RequestInit) {
            return gate.fetch(new Request(request, init));
          },
        };
      },
    },
  };
}

async function hydrateAndLease(gate: AnonymousChatGate): Promise<void> {
  expect(
    (
      await post(gate, "/hydrate", {
        sessionId: "session-conversion",
        userId: "user-conversion",
        messageCount: 0,
        messagesLimit: 10,
        hourlyMessageCount: 0,
        hourlyResetAtMs: null,
        hourlyLimit: 10,
        expiresAtMs: Date.now() + 86_400_000,
        revision: 0,
        blocked: false,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(gate, "/lease", {
        requestId: "request-before-conversion",
      })
    ).status,
  ).toBe(200);
}

describe("anonymous-session restrictive lifecycle", () => {
  test("conversion rejects an already-issued lease before the database mutation", async () => {
    const gate = new AnonymousChatGate(
      { storage: new TestStorage() } as unknown as DurableObjectState,
      {} as never,
    );
    await hydrateAndLease(gate);
    let dispatchStatusDuringPersistence: number | undefined;

    await runWithCloudBindingsAsync(bindingsFor(gate), async () => {
      await persistAnonymousSessionRestriction(
        "copied-session-token",
        async () => {
          dispatchStatusDuringPersistence = (
            await post(gate, "/dispatch", {
              requestId: "request-before-conversion",
            })
          ).status;
        },
      );
    });

    expect(dispatchStatusDuringPersistence).toBe(410);
  });

  test("a failed or missing gate never commits the restrictive database mutation", async () => {
    const persist = mock(async () => undefined);
    await expect(
      persistAnonymousSessionRestriction("copied-session-token", persist),
    ).rejects.toThrow("Anonymous chat gate binding is unavailable");
    expect(persist).not.toHaveBeenCalled();

    await expect(
      runWithCloudBindingsAsync(
        {
          ANONYMOUS_CHAT_GATES: {
            getByName() {
              return {
                fetch: async () => Response.json({}, { status: 503 }),
              };
            },
          },
        },
        () =>
          persistAnonymousSessionRestriction("copied-session-token", persist),
      ),
    ).rejects.toThrow("invalidation failed with status 503");
    expect(persist).not.toHaveBeenCalled();
  });
});
