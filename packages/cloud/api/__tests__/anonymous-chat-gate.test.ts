/**
 * Exercises anonymous chat's strongly ordered cache with in-memory Durable
 * Object storage, including cold hydration, concurrency, and late refunds.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AnonymousChatGate } from "../src/anonymous-chat-gate";

class TestStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

function createGate(storage = new TestStorage()): AnonymousChatGate {
  return new AnonymousChatGate(
    { storage } as unknown as DurableObjectState,
    {} as never,
  );
}

function post(
  gate: AnonymousChatGate,
  path: "/context" | "/hydrate" | "/lease" | "/refund" | "/commit",
  body: Record<string, unknown> = {},
): Promise<Response> {
  return gate.fetch(
    new Request(`https://gate.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function hydrate(
  gate: AnonymousChatGate,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Response> {
  return await post(gate, "/hydrate", {
    sessionId: "session-a",
    userId: "user-a",
    messageCount: 0,
    messagesLimit: 10,
    hourlyMessageCount: 0,
    hourlyResetAtMs: null,
    hourlyLimit: 10,
    expiresAtMs: Date.now() + 86_400_000,
    revision: 0,
    blocked: false,
    ...overrides,
  });
}

afterEach(() => {
  spyOn(Date, "now").mockRestore();
});

describe("AnonymousChatGate", () => {
  test("fails cold and accepts only the first hydration snapshot", async () => {
    const gate = createGate();
    const cold = await post(gate, "/context");
    expect(cold.status).toBe(503);
    expect(await cold.json()).toHaveProperty(
      "code",
      "anonymous_chat_gate_uninitialized",
    );

    expect((await hydrate(gate, { messageCount: 2 })).status).toBe(200);
    expect((await hydrate(gate, { messageCount: 9, revision: 9 })).status).toBe(
      200,
    );

    const context = await (await post(gate, "/context")).json();
    expect(context).toHaveProperty("context.messageCount", 2);
  });

  test("serializes concurrent lifetime leases", async () => {
    const gate = createGate();
    await hydrate(gate, { messagesLimit: 1 });

    const responses = await Promise.all([
      post(gate, "/lease", { requestId: "request-a" }),
      post(gate, "/lease", { requestId: "request-b" }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 429,
    ]);
  });

  test("makes refunds idempotent without decrementing below zero", async () => {
    const gate = createGate();
    await hydrate(gate);
    expect(
      (await post(gate, "/lease", { requestId: "request-a" })).status,
    ).toBe(200);

    const first = await post(gate, "/refund", { requestId: "request-a" });
    const second = await post(gate, "/refund", { requestId: "request-a" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      duplicate: true,
      snapshot: { messageCount: 0, hourlyMessageCount: 0, revision: 2 },
    });
  });

  test("does not subtract an old lease from a new hourly window", async () => {
    let now = 1_800_000_000_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const gate = createGate();
    await hydrate(gate, {
      messagesLimit: 2,
      hourlyLimit: 1,
      expiresAtMs: now + 86_400_000,
    });

    expect(
      (await post(gate, "/lease", { requestId: "request-a" })).status,
    ).toBe(200);
    now += 60 * 60 * 1_000 + 1;
    expect(
      (await post(gate, "/refund", { requestId: "request-a" })).status,
    ).toBe(200);
    const next = await post(gate, "/lease", { requestId: "request-b" });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({
      snapshot: { messageCount: 1, hourlyMessageCount: 1 },
    });
  });

  test("rejects commit after refund and keeps repeat commit idempotent", async () => {
    const gate = createGate();
    await hydrate(gate);
    await post(gate, "/lease", { requestId: "request-a" });
    expect(
      (await post(gate, "/commit", { requestId: "request-a" })).status,
    ).toBe(200);
    expect(
      (await post(gate, "/commit", { requestId: "request-a" })).status,
    ).toBe(200);
    expect(
      (await post(gate, "/refund", { requestId: "request-a" })).status,
    ).toBe(409);
  });
});
