/**
 * Managed Cloud conversation isolation at the real HTTP route boundary. The
 * deterministic runtime models one dedicated agent serving two principals and
 * proves persisted ownership survives restore without becoming caller-writable
 * or leaking through REST, search, mutation, message-send, or global sockets.
 */
import type { AgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { buildConversationRoomMetadata } from "../conversation-metadata.ts";
import {
  restoreConversationsFromDb,
  WEB_CONVERSATION_CHANNEL_PREFIX,
} from "../conversation-restore.ts";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

const TOKEN = "dedicated-agent-principal-token";
const PRINCIPAL_A = "cloud-user-a";
const PRINCIPAL_B = "cloud-user-b";
const OWNER_A = stringToUuid(PRINCIPAL_A);
const OWNER_B = stringToUuid(PRINCIPAL_B);
const AGENT_ID = stringToUuid("cloud-agent");
const ROOM_A = stringToUuid("web-conv-conversation-a");
const ROOM_B = stringToUuid("web-conv-conversation-b");
const LEGACY_ROOM = stringToUuid("web-conv-legacy-conversation");
const MESSAGE_A = stringToUuid("cloud-message-a");

const previousCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;
const previousApiToken = process.env.ELIZA_API_TOKEN;

function persistedRoom(
  conversationId: string,
  roomId: UUID,
  cloudOwnerEntityId?: UUID,
): Room {
  return {
    id: roomId,
    name: `Private ${conversationId}`,
    channelId: `${WEB_CONVERSATION_CHANNEL_PREFIX}${conversationId}`,
    metadata: buildConversationRoomMetadata(
      {
        id: conversationId,
        ...(cloudOwnerEntityId ? { cloudOwnerEntityId } : {}),
      },
      AGENT_ID,
    ),
  } as Room;
}

function createRuntime() {
  const rooms = [
    persistedRoom("conversation-a", ROOM_A, OWNER_A),
    persistedRoom("conversation-b", ROOM_B, OWNER_B),
    persistedRoom("legacy-conversation", LEGACY_ROOM),
  ];
  const memories: Memory[] = [
    {
      id: MESSAGE_A,
      entityId: OWNER_A,
      agentId: AGENT_ID,
      roomId: ROOM_A,
      content: { text: "Principal A private message" },
      createdAt: 1_700_000_000_000,
    },
  ];
  const searchMessages = vi.fn(async () => []);
  const deleteManyMemories = vi.fn(async (memoryIds: UUID[]) => {
    for (const memoryId of memoryIds) {
      const index = memories.findIndex((memory) => memory.id === memoryId);
      if (index >= 0) memories.splice(index, 1);
    }
  });
  const updateRoom = vi.fn(async (nextRoom: Room) => {
    const index = rooms.findIndex((room) => room.id === nextRoom.id);
    if (index >= 0) rooms[index] = nextRoom;
    else rooms.push(nextRoom);
  });
  const deleteRoom = vi.fn(async (roomId: UUID) => {
    const index = rooms.findIndex((room) => room.id === roomId);
    if (index >= 0) rooms.splice(index, 1);
  });
  const ensureConnection = vi.fn(
    async (connection: {
      roomId: UUID;
      channelId: string;
      metadata?: Record<string, unknown>;
    }) => {
      if (rooms.some((room) => room.id === connection.roomId)) return;
      rooms.push({
        id: connection.roomId,
        name: "Chat",
        channelId: connection.channelId,
        metadata: connection.metadata,
      } as Room);
    },
  );
  const createMemory = vi.fn(async (memory: Memory) => {
    memories.push(memory);
    return true;
  });
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Cloud Agent" },
    getRoomsByWorld: vi.fn(async () => rooms),
    getRoom: vi.fn(async (roomId: UUID) =>
      rooms.find((room) => room.id === roomId),
    ),
    getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) =>
      memories.filter((memory) => memory.roomId === roomId),
    ),
    getMemoriesByIds: vi.fn(async (memoryIds: UUID[]) =>
      memories.filter((memory) => memory.id && memoryIds.includes(memory.id)),
    ),
    getWorld: vi.fn(async () => null),
    updateWorld: vi.fn(async () => undefined),
    ensureConnection,
    createMemory,
    deleteManyMemories,
    deleteRoom,
    adapter: { updateRoom },
    searchMessages,
  } as unknown as AgentRuntime;
  return {
    runtime,
    rooms,
    memories,
    searchMessages,
    deleteManyMemories,
    deleteRoom,
    ensureConnection,
    createMemory,
    updateRoom,
  };
}

async function createRestoredState() {
  const harness = createRuntime();
  const broadcastWs = vi.fn();
  const state = {
    runtime: harness.runtime,
    config: {},
    agentName: "Cloud Agent",
    adminEntityId: AGENT_ID,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map<string, ConversationMeta>(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs,
  } as unknown as ConversationRouteState;
  const restored = await restoreConversationsFromDb(harness.runtime, state);
  return { ...harness, state, broadcastWs, restored };
}

interface RouteResponse {
  status: number;
  body: unknown;
  readJsonBody: ReturnType<typeof vi.fn>;
}

function request(
  state: ConversationRouteState,
  options: {
    method: string;
    pathname: string;
    principal?: string;
    token?: string;
    body?: Record<string, unknown>;
  },
): Promise<RouteResponse> {
  const readJsonBody = vi.fn(async () => options.body ?? {});
  return new Promise((resolve) => {
    const finish = (status: number, body: unknown) =>
      resolve({ status, body, readJsonBody });
    const headers: Record<string, string> = { host: "localhost" };
    if (options.principal) headers["x-eliza-user-id"] = options.principal;
    if (options.token) headers["x-eliza-principal-token"] = options.token;
    const ctx = {
      req: { url: options.pathname, headers },
      res: {},
      method: options.method,
      pathname: options.pathname.split("?")[0],
      readJsonBody,
      json: (_res: unknown, body: unknown, status = 200) =>
        finish(status, body),
      error: (_res: unknown, message: string, status = 500) =>
        finish(status, { error: message }),
      state,
    } as unknown as ConversationRouteContext;
    void handleConversationRoutes(ctx);
  });
}

function asConversationList(body: unknown): Array<Record<string, unknown>> {
  return (body as { conversations: Array<Record<string, unknown>> })
    .conversations;
}

beforeAll(() => {
  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.ELIZA_API_TOKEN = TOKEN;
});

beforeEach(() => {
  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.ELIZA_API_TOKEN = TOKEN;
});

afterAll(() => {
  if (previousCloudProvisioned === undefined) {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  } else {
    process.env.ELIZA_CLOUD_PROVISIONED = previousCloudProvisioned;
  }
  if (previousApiToken === undefined) {
    delete process.env.ELIZA_API_TOKEN;
  } else {
    process.env.ELIZA_API_TOKEN = previousApiToken;
  }
});

describe("managed Cloud conversation principals", () => {
  it("restores two principals on one runtime, lists only the caller, and fails legacy rows closed", async () => {
    const { state, restored } = await createRestoredState();

    expect(restored).toBe(3);
    expect(state.conversations.get("conversation-a")?.cloudOwnerEntityId).toBe(
      OWNER_A,
    );
    expect(state.conversations.get("conversation-b")?.cloudOwnerEntityId).toBe(
      OWNER_B,
    );
    expect(
      state.conversations.get("legacy-conversation")?.cloudOwnerEntityId,
    ).toBeUndefined();

    const [responseA, responseB] = await Promise.all([
      request(state, {
        method: "GET",
        pathname: "/api/conversations",
        principal: PRINCIPAL_A,
        token: TOKEN,
      }),
      request(state, {
        method: "GET",
        pathname: "/api/conversations",
        principal: PRINCIPAL_B,
        token: TOKEN,
      }),
    ]);

    expect(asConversationList(responseA.body).map(({ id }) => id)).toEqual([
      "conversation-a",
    ]);
    expect(asConversationList(responseB.body).map(({ id }) => id)).toEqual([
      "conversation-b",
    ]);
    expect(asConversationList(responseA.body)[0]).not.toHaveProperty(
      "cloudOwnerEntityId",
    );

    const missingPrincipal = await request(state, {
      method: "GET",
      pathname: "/api/conversations",
      token: TOKEN,
    });
    const invalidToken = await request(state, {
      method: "GET",
      pathname: "/api/conversations",
      principal: PRINCIPAL_A,
      token: "wrong-token",
    });
    expect(missingPrincipal.status).toBe(401);
    expect(invalidToken.status).toBe(401);
  });

  it("scopes search at the store boundary before limit and ranking", async () => {
    const { state, searchMessages } = await createRestoredState();

    await request(state, {
      method: "GET",
      pathname: "/api/conversations/messages/search?q=private",
      principal: PRINCIPAL_A,
      token: TOKEN,
    });
    expect(searchMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ roomIds: [ROOM_A], query: "private" }),
    );

    await request(state, {
      method: "GET",
      pathname: "/api/conversations/messages/search?q=private",
      principal: PRINCIPAL_B,
      token: TOKEN,
    });
    expect(searchMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ roomIds: [ROOM_B], query: "private" }),
    );
  });

  it("returns the same non-oracular 404 before reading or mutating a foreign conversation", async () => {
    const { state, memories, broadcastWs } = await createRestoredState();
    const attempts = await Promise.all([
      request(state, {
        method: "GET",
        pathname: "/api/conversations/conversation-b/messages",
        principal: PRINCIPAL_A,
        token: TOKEN,
      }),
      request(state, {
        method: "POST",
        pathname: "/api/conversations/conversation-b/messages",
        principal: PRINCIPAL_A,
        token: TOKEN,
        body: { text: "steal this conversation" },
      }),
      request(state, {
        method: "POST",
        pathname: "/api/conversations/conversation-b/import",
        principal: PRINCIPAL_A,
        token: TOKEN,
        body: { messages: [{ role: "user", text: "steal" }] },
      }),
      request(state, {
        method: "POST",
        pathname: "/api/conversations/conversation-b/messages/truncate",
        principal: PRINCIPAL_A,
        token: TOKEN,
        body: { messageId: MESSAGE_A },
      }),
      request(state, {
        method: "DELETE",
        pathname: `/api/conversations/conversation-b/messages/${MESSAGE_A}`,
        principal: PRINCIPAL_A,
        token: TOKEN,
      }),
      request(state, {
        method: "POST",
        pathname: "/api/conversations/conversation-b/messages/stream",
        principal: PRINCIPAL_A,
        token: TOKEN,
        body: { text: "steal this conversation" },
      }),
      request(state, {
        method: "POST",
        pathname: "/api/conversations/conversation-b/greeting",
        principal: PRINCIPAL_A,
        token: TOKEN,
      }),
      request(state, {
        method: "PATCH",
        pathname: "/api/conversations/conversation-b",
        principal: PRINCIPAL_A,
        token: TOKEN,
        body: { title: "stolen" },
      }),
      request(state, {
        method: "DELETE",
        pathname: "/api/conversations/conversation-b",
        principal: PRINCIPAL_A,
        token: TOKEN,
      }),
    ]);

    expect(attempts.map(({ status }) => status)).toEqual([
      404, 404, 404, 404, 404, 404, 404, 404, 404,
    ]);
    for (const index of [1, 2, 3, 5, 7]) {
      expect(attempts[index].readJsonBody).not.toHaveBeenCalled();
    }
    expect(state.conversations.has("conversation-b")).toBe(true);
    expect(memories).toHaveLength(1);
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("attests new ownership server-side and never returns the internal owner field", async () => {
    const { state } = await createRestoredState();
    state.runtime = null;
    const conversationsBeforeSpoof = state.conversations.size;
    const spoofed = await request(state, {
      method: "POST",
      pathname: "/api/conversations",
      principal: PRINCIPAL_A,
      token: TOKEN,
      body: {
        title: "Principal A new chat",
        cloudOwnerEntityId: OWNER_B,
      },
    });
    expect(spoofed.status).toBe(400);
    expect(state.conversations.size).toBe(conversationsBeforeSpoof);

    const created = await request(state, {
      method: "POST",
      pathname: "/api/conversations",
      principal: PRINCIPAL_A,
      token: TOKEN,
      body: {
        title: "Principal A new chat",
        metadata: { scope: "general" },
      },
    });

    expect(created.status).toBe(200);
    const publicConversation = (
      created.body as { conversation: Record<string, unknown> }
    ).conversation;
    expect(publicConversation).not.toHaveProperty("cloudOwnerEntityId");
    const stored = state.conversations.get(String(publicConversation.id));
    expect(stored?.cloudOwnerEntityId).toBe(OWNER_A);
    expect(stored?.metadata).toEqual({ scope: "general" });

    const nestedSpoof = await request(state, {
      method: "PATCH",
      pathname: `/api/conversations/${publicConversation.id}`,
      principal: PRINCIPAL_A,
      token: TOKEN,
      body: {
        metadata: {
          scope: "general",
          cloudOwnerEntityId: OWNER_B,
        },
      },
    });
    expect(nestedSpoof.status).toBe(400);
    expect(stored?.cloudOwnerEntityId).toBe(OWNER_A);

    const responseB = await request(state, {
      method: "GET",
      pathname: "/api/conversations",
      principal: PRINCIPAL_B,
      token: TOKEN,
    });
    expect(
      asConversationList(responseB.body).some(
        ({ id }) => id === publicConversation.id,
      ),
    ).toBe(false);
  });

  it("broadcasts only public conversation DTOs for principal-bound socket routing", async () => {
    const cloudHarness = await createRestoredState();
    const deleted = await request(cloudHarness.state, {
      method: "DELETE",
      pathname: `/api/conversations/conversation-a/messages/${MESSAGE_A}`,
      principal: PRINCIPAL_A,
      token: TOKEN,
    });
    expect(deleted.status).toBe(200);
    expect(cloudHarness.deleteManyMemories).toHaveBeenCalledWith([MESSAGE_A]);
    expect(cloudHarness.broadcastWs).toHaveBeenCalledWith({
      type: "conversation-updated",
      conversation: expect.not.objectContaining({
        cloudOwnerEntityId: OWNER_A,
      }),
    });

    delete process.env.ELIZA_CLOUD_PROVISIONED;
    const localHarness = await createRestoredState();
    const localDeleted = await request(localHarness.state, {
      method: "DELETE",
      pathname: `/api/conversations/conversation-a/messages/${MESSAGE_A}`,
    });
    expect(localDeleted.status).toBe(200);
    expect(localHarness.broadcastWs).toHaveBeenCalledWith({
      type: "conversation-updated",
      conversation: expect.not.objectContaining({
        cloudOwnerEntityId: OWNER_A,
      }),
    });
  });

  it("rehydrates an evicted backing room before import so another principal cannot claim it", async () => {
    const { state, memories } = await createRestoredState();
    state.conversations.delete("conversation-a");

    const attempt = await request(state, {
      method: "POST",
      pathname: "/api/conversations/conversation-a/import",
      principal: PRINCIPAL_B,
      token: TOKEN,
      body: { messages: [{ role: "user", text: "claim existing room" }] },
    });

    expect(attempt.status).toBe(404);
    expect(attempt.readJsonBody).not.toHaveBeenCalled();
    expect(state.conversations.get("conversation-a")?.cloudOwnerEntityId).toBe(
      OWNER_A,
    );
    expect(memories.map((memory) => memory.content.text)).toEqual([
      "Principal A private message",
    ]);
  });

  it("persists imported ownership and restores it after an in-memory restart", async () => {
    const { state, runtime, rooms } = await createRestoredState();
    const imported = await request(state, {
      method: "POST",
      pathname: "/api/conversations/handoff-conversation/import",
      principal: PRINCIPAL_A,
      token: TOKEN,
      body: {
        title: "Imported chat",
        messages: [{ role: "user", text: "Preserve me" }],
      },
    });

    expect(imported.status).toBe(200);
    const persisted = rooms.find(
      (room) => room.channelId === "web-conv-handoff-conversation",
    );
    expect(persisted?.metadata).toMatchObject({
      webConversation: {
        conversationId: "handoff-conversation",
        cloudOwnerEntityId: OWNER_A,
      },
    });

    const restarted = new Map<string, ConversationMeta>();
    await restoreConversationsFromDb(runtime, {
      conversations: restarted,
      deletedConversationIds: new Set(),
    });
    expect(restarted.get("handoff-conversation")?.cloudOwnerEntityId).toBe(
      OWNER_A,
    );
  });

  it("uses the same 404 for foreign and absent Cloud deletes", async () => {
    const { state } = await createRestoredState();
    const [foreign, absent] = await Promise.all([
      request(state, {
        method: "DELETE",
        pathname: "/api/conversations/conversation-b",
        principal: PRINCIPAL_A,
        token: TOKEN,
      }),
      request(state, {
        method: "DELETE",
        pathname: "/api/conversations/not-a-conversation",
        principal: PRINCIPAL_A,
        token: TOKEN,
      }),
    ]);

    expect([foreign.status, absent.status]).toEqual([404, 404]);
    expect(state.deletedConversationIds.has("not-a-conversation")).toBe(false);
  });

  it("cleanup-empty leaves another principal's empty rooms untouched", async () => {
    const { state, rooms } = await createRestoredState();
    const response = await request(state, {
      method: "POST",
      pathname: "/api/conversations/cleanup-empty",
      principal: PRINCIPAL_A,
      token: TOKEN,
      body: {},
    });

    expect(response.status).toBe(200);
    expect(state.conversations.has("conversation-b")).toBe(true);
    expect(rooms.some((room) => room.id === ROOM_B)).toBe(true);
  });

  it("keeps ownership registered when durable deletion fails", async () => {
    const { state, deleteRoom } = await createRestoredState();
    deleteRoom.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request(state, {
      method: "DELETE",
      pathname: "/api/conversations/conversation-a",
      principal: PRINCIPAL_A,
      token: TOKEN,
    });

    expect(response.status).toBe(500);
    expect(state.conversations.get("conversation-a")?.cloudOwnerEntityId).toBe(
      OWNER_A,
    );
    expect(state.deletedConversationIds.has("conversation-a")).toBe(false);
  });

  it("does not expose the development corpus mutator in managed Cloud", async () => {
    const { state } = await createRestoredState();
    const response = await request(state, {
      method: "POST",
      pathname: "/api/conversations/dev/seed-messages",
      principal: PRINCIPAL_A,
      token: TOKEN,
      body: { conversations: 1, messagesPerConversation: 1 },
    });

    expect(response.status).toBe(404);
    expect(response.readJsonBody).not.toHaveBeenCalled();
  });
});
