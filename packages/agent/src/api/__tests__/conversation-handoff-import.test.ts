/**
 * Drives the silent shared-to-dedicated import route against a real in-memory
 * database, including retry, partial-write recovery, conflict, and goal adoption.
 */

import crypto from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../../core/src/database/inMemoryAdapter.ts";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000d2" as UUID;
const CONVERSATION_ID = "handoff-conversation";

interface RuntimeFixture {
  runtime: Record<string, unknown>;
  failOnCreateCall?: number;
  createCalls: number;
  goalService?: {
    adoptActivationGoal: ReturnType<typeof vi.fn>;
  };
}

function makeRuntime(adapter: InMemoryDatabaseAdapter): RuntimeFixture {
  const fixture: RuntimeFixture = {
    runtime: {},
    createCalls: 0,
  };
  fixture.runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    async ensureConnection(params: { roomId: UUID; roomName?: string }) {
      await adapter.createRooms([
        {
          id: params.roomId,
          agentId: AGENT_ID,
          name: params.roomName,
          source: "test",
          type: ChannelType.DM,
        } as Parameters<InMemoryDatabaseAdapter["createRooms"]>[0][number],
      ]);
    },
    async createMemory(memory: Memory, tableName: string) {
      fixture.createCalls += 1;
      if (fixture.failOnCreateCall === fixture.createCalls) {
        throw new Error("injected durable write failure");
      }
      if (
        memory.id &&
        (await adapter.getMemoriesByIds([memory.id])).length > 0
      ) {
        throw new Error("duplicate memory id");
      }
      const [id] = await adapter.createMemories([{ memory, tableName }]);
      return id;
    },
    async getMemories(params: {
      roomId: UUID;
      tableName: string;
      limit?: number;
    }) {
      return adapter.getMemories({
        roomId: params.roomId,
        tableName: params.tableName,
        count: params.limit,
      });
    },
    async getMemoryById(id: UUID) {
      return (await adapter.getMemoriesByIds([id]))[0] ?? null;
    },
    async getCache<T>(key: string): Promise<T | undefined> {
      return (await adapter.getCaches<T>([key])).get(key);
    },
    async setCache<T>(key: string, value: T) {
      return adapter.setCaches([{ key, value }]);
    },
    getService(type: string) {
      return type === "lifeops_activation_goal_handoff"
        ? (fixture.goalService ?? null)
        : null;
    },
    __worlds: new Map<string, Record<string, unknown>>(),
    async getWorld(worldId: UUID) {
      const worlds = (this as { __worlds: Map<string, unknown> }).__worlds;
      if (!worlds.has(worldId)) {
        worlds.set(worldId, {
          id: worldId,
          agentId: AGENT_ID,
          name: "test-world",
          serverId: "test-server",
          metadata: {},
        });
      }
      return worlds.get(worldId);
    },
    async updateWorld(world: { id: UUID }) {
      (this as { __worlds: Map<string, unknown> }).__worlds.set(
        world.id,
        world,
      );
    },
    async getRoom(roomId: UUID) {
      return (await adapter.getRoomsByIds([roomId]))?.[0] ?? null;
    },
    adapter: {
      async updateRoom() {},
    },
  };
  return fixture;
}

function makeState(runtime: RuntimeFixture): ConversationRouteState {
  return {
    runtime: runtime.runtime,
    agentName: "Eliza",
    config: { ui: {} },
    adminEntityId: USER_ID,
    chatUserId: USER_ID,
    conversations: new Map(),
    deletedConversationIds: new Set<string>(),
    conversationRestorePromise: null,
    broadcastWs: vi.fn(),
  } as unknown as ConversationRouteState;
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function importConversation(
  state: ConversationRouteState,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Captured> {
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const pathname = `/api/conversations/${CONVERSATION_ID}/import`;
    const ctx = {
      req: {
        url: pathname,
        headers: { host: "localhost", ...headers },
      },
      res: {},
      method: "POST",
      pathname,
      readJsonBody: async () => body,
      json: (_res: unknown, data: unknown, status = 200) => {
        captured.status = status;
        captured.body = data as Record<string, unknown>;
        resolve(captured as Captured);
      },
      error: (_res: unknown, message: string, status = 500) => {
        captured.status = status;
        captured.body = { error: message };
        resolve(captured as Captured);
      },
      state,
    } as unknown as ConversationRouteContext;
    void handleConversationRoutes(ctx);
  });
}

function waifuAccessToken(role: "admin" | "user" | "guest"): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: Math.floor(Date.now() / 1000) + 300,
      role,
      walletAddress: "0x1111111111111111111111111111111111111111",
    }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", process.env.WAIFU_CHAT_ACCESS_JWT_SECRET ?? "")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const MESSAGES = [
  {
    id: "shared-owner-1",
    role: "user",
    text: "Help me ship the iOS app by September.",
    timestamp: 1_785_000_000_000,
  },
  {
    id: "shared-assistant-1",
    role: "assistant",
    text: "I can help turn that into milestones.",
    timestamp: 1_785_000_000_001,
  },
];

describe("POST /api/conversations/:id/import", () => {
  let adapter: InMemoryDatabaseAdapter;
  let runtime: RuntimeFixture;
  let state: ConversationRouteState;

  beforeEach(async () => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "handoff-owner-boundary-secret";
    adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    runtime = makeRuntime(adapter);
    state = makeState(runtime);
  });

  afterEach(() => {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
  });

  it("rejects a non-owner before creating a conversation or importing rows", async () => {
    const response = await importConversation(
      state,
      { messages: MESSAGES },
      { authorization: `Bearer ${waifuAccessToken("user")}` },
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("Only the owner");
    expect(state.conversations.has(CONVERSATION_ID)).toBe(false);
    expect(runtime.createCalls).toBe(0);
  });

  it("imports once and a retry with changed transport timestamps inserts nothing", async () => {
    const first = await importConversation(state, { messages: MESSAGES });
    const retry = await importConversation(state, {
      messages: MESSAGES.map((message) => ({
        ...message,
        timestamp: message.timestamp + 10_000,
      })),
    });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ inserted: 2, skipped: 0 });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      inserted: 0,
      skipped: 2,
      alreadyPopulated: true,
    });
    const conversation = state.conversations.get(CONVERSATION_ID);
    if (!conversation) throw new Error("import did not create conversation");
    const memories = await adapter.getMemories({
      roomId: conversation.roomId,
      tableName: "messages",
      count: 20,
    });
    expect(memories).toHaveLength(2);
    expect(
      memories
        .slice()
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
        .map((memory) => memory.content.text),
    ).toEqual(MESSAGES.map((message) => message.text));
  });

  it("resumes the missing suffix after a real durable write failure", async () => {
    runtime.failOnCreateCall = 2;
    const interrupted = await importConversation(state, { messages: MESSAGES });
    expect(interrupted.status).toBe(500);
    expect(interrupted.body.error).toContain("durable write failure");

    runtime.failOnCreateCall = undefined;
    const resumed = await importConversation(state, { messages: MESSAGES });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ inserted: 1, skipped: 1 });

    const conversation = state.conversations.get(CONVERSATION_ID);
    if (!conversation) throw new Error("import did not create conversation");
    const memories = await adapter.getMemories({
      roomId: conversation.roomId,
      tableName: "messages",
      count: 20,
    });
    expect(memories).toHaveLength(2);
  });

  it("fails closed when one stable source id is reused for different content", async () => {
    await importConversation(state, { messages: [MESSAGES[0]] });
    const conflict = await importConversation(state, {
      messages: [{ ...MESSAGES[0], text: "Different content under same id" }],
    });

    expect(conflict.status).toBe(500);
    expect(conflict.body.error).toContain(
      "handoff import id already belongs to different message content",
    );
  });

  it("requires durable accepted-goal readback before reporting handoff success", async () => {
    const adoptActivationGoal = vi.fn(async () => ({
      adopted: true,
      verified: true,
      goal: "Ship the iOS app by September",
    }));
    runtime.goalService = { adoptActivationGoal };
    const activationGoal = {
      activationVersion: "1",
      status: "accepted",
      response: {
        messageId: "shared-owner-1",
        text: MESSAGES[0].text,
        createdAt: MESSAGES[0].timestamp,
      },
      goal: {
        text: "Ship the iOS app by September",
        confidence: 0.95,
        model: "live-model",
        recordedAt: MESSAGES[1].timestamp,
      },
    };

    const response = await importConversation(state, {
      messages: MESSAGES,
      activationGoal,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      activationGoalAdopted: true,
      activationGoalVerified: true,
    });
    expect(adoptActivationGoal).toHaveBeenCalledWith(activationGoal);
  });
});
