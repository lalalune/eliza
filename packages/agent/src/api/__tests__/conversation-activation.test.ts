/**
 * Exercises durable post-sign-in activation against the real in-memory
 * database adapter, including concurrency, restart, deletion, and owner scope.
 */

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../../core/src/database/inMemoryAdapter.ts";
import { ensurePostSignInActivation } from "../conversation-activation.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const OTHER_OWNER_ID = "00000000-0000-0000-0000-0000000000b2" as UUID;
const FIRST_ROOM_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const SECOND_ROOM_ID = "22222222-2222-4222-8222-222222222222" as UUID;

function makeRuntime(adapter: InMemoryDatabaseAdapter): AgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    async createMemory(memory: Memory, tableName: string) {
      const [id] = await adapter.createMemories([{ memory, tableName }]);
      return id;
    },
    async getMemoryById(id: UUID) {
      return (await adapter.getMemoriesByIds([id]))[0] ?? null;
    },
    async getCache<T>(key: string): Promise<T | undefined> {
      return (await adapter.getCaches<T>([key])).get(key);
    },
    setCache<T>(key: string, value: T) {
      return adapter.setCaches([{ key, value }]);
    },
  } as unknown as AgentRuntime;
}

function activate(
  runtime: AgentRuntime,
  options: {
    ownerId?: UUID;
    conversationId?: string;
    roomId?: UUID;
  } = {},
) {
  return ensurePostSignInActivation({
    runtime,
    ownerId: options.ownerId ?? OWNER_ID,
    conversationId: options.conversationId ?? "first-conversation",
    roomId: options.roomId ?? FIRST_ROOM_ID,
  });
}

describe("post-sign-in activation durability", () => {
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
  });

  it("coalesces concurrent requests in the winning conversation", async () => {
    const runtime = makeRuntime(adapter);
    const [first, second] = await Promise.all([
      activate(runtime),
      activate(runtime),
    ]);

    expect(first.text).toContain("What would you like to work on first");
    expect(first.persisted).toBe(true);
    expect(second.text).toBe("");
    expect(second.generated).toBe(false);
    expect(second.persisted).toBe(false);
    expect(second.messageId).toBe(first.messageId);

    const messages = await adapter.getMemories({
      roomId: FIRST_ROOM_ID,
      tableName: "messages",
      count: 20,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(first.messageId);
  });

  it("chooses one conversation when different rooms race", async () => {
    const runtime = makeRuntime(adapter);
    const [winner, loser] = await Promise.all([
      activate(runtime),
      activate(runtime, {
        conversationId: "second-conversation",
        roomId: SECOND_ROOM_ID,
      }),
    ]);

    expect(winner.text).not.toBe("");
    expect(winner.conversationId).toBe("first-conversation");
    expect(loser.text).toBe("");
    expect(loser.generated).toBe(false);
    expect(loser.conversationId).toBe("first-conversation");
    expect(loser.messageId).toBe(winner.messageId);
  });

  it("reuses the durable ledger after a runtime restart", async () => {
    const first = await activate(makeRuntime(adapter));
    const restored = await activate(makeRuntime(adapter));

    expect(restored.messageId).toBe(first.messageId);
    expect(restored.timestamp).toBe(first.timestamp);
    expect(restored.text).toBe("");
    expect(restored.generated).toBe(false);
    expect(restored.persisted).toBe(false);
  });

  it("does not replay after the winning conversation is deleted", async () => {
    const first = await activate(makeRuntime(adapter));
    await adapter.deleteMemories([first.messageId as UUID]);

    const afterDeletion = await activate(makeRuntime(adapter), {
      conversationId: "second-conversation",
      roomId: SECOND_ROOM_ID,
    });

    expect(afterDeletion.text).toBe("");
    expect(afterDeletion.generated).toBe(false);
    expect(afterDeletion.messageId).toBe(first.messageId);
    expect(
      (await adapter.getMemoriesByIds([first.messageId as UUID]))[0] ?? null,
    ).toBeNull();
  });

  it("scopes activation independently per owner", async () => {
    const runtime = makeRuntime(adapter);
    const owner = await activate(runtime);
    const otherOwner = await activate(runtime, {
      ownerId: OTHER_OWNER_ID,
      conversationId: "second-conversation",
      roomId: SECOND_ROOM_ID,
    });

    expect(otherOwner.text).not.toBe("");
    expect(otherOwner.messageId).not.toBe(owner.messageId);
  });
});
