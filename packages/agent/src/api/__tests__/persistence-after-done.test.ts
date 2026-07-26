/**
 * Verifies that the streaming chat handler treats `done` as a durable commit
 * boundary: assistant persistence resolves before the terminal frame and both
 * ids in that frame already exist. Persistence failures become terminal SSE
 * errors rather than a false successful completion.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import {
  ChannelType,
  logger,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the persistence promise so the test can resolve it on demand and
// assert ordering against the SSE writes.
let persistResolve: (() => void) | null = null;
let persistReject: ((err: unknown) => void) | null = null;
let persistCalledAt: number | null = null;
let persistResolvedAt: number | null = null;
let captureGenerateAbortSignal: AbortSignal | undefined;
let generateWaitsForAbort = false;
let generateThrowsTurnAbort = false;
let generateThrowsTimeout = false;
let assistantMemoryAlreadyPersisted = false;

// Connection readiness has its own integration suite. This fixture isolates
// the later assistant commit boundary and therefore supplies an already-valid
// descriptor without running world/room topology writes.
vi.mock("../conversation-connection-readiness.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../conversation-connection-readiness.ts")
  >("../conversation-connection-readiness.ts");
  return {
    ...actual,
    captureConversationConnectionDescriptor: vi.fn((input) => ({
      ...input,
      runtimeAgentId: input.runtime.agentId,
      topologyIdentity: "test-topology",
      proofIdentity: "test-proof",
      topologyGeneration: 1,
      roomGeneration: 1,
    })),
    scheduleConversationConnectionEnsure: vi.fn(async () => undefined),
    assertConversationConnectionRuntime: vi.fn(),
  };
});

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    initSse: vi.fn((res: http.ServerResponse) => {
      res.setHeader("Content-Type", "text/event-stream");
    }),
    writeSse: vi.fn((res: http.ServerResponse, payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }),
    writeSseJson: vi.fn((res: http.ServerResponse, payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }),
    writeChatTokenSse: vi.fn(
      (res: http.ServerResponse, chunk: string, fullText: string) => {
        res.write(
          `data: ${JSON.stringify({ type: "token", text: chunk, fullText })}\n\n`,
        );
      },
    ),
    readChatRequestPayload: vi.fn(async () => ({
      prompt: "hello",
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
    })),
    persistAssistantConversationMemory: vi.fn(async () => {
      persistCalledAt = Date.now();
      return new Promise<Memory>((resolve, reject) => {
        persistResolve = () => {
          persistResolvedAt = Date.now();
          resolve({
            id: stringToUuid("assistant-msg-store") as UUID,
            entityId: stringToUuid("agent-1"),
            agentId: stringToUuid("agent-1"),
            roomId: stringToUuid("room-1"),
            content: { text: "ok" },
          });
        };
        persistReject = (err) => {
          persistResolvedAt = Date.now();
          reject(err);
        };
      });
    }),
    generateChatResponse: vi.fn(async (_runtime, _msg, agentName, opts) => {
      captureGenerateAbortSignal = opts?.abortSignal;
      if (generateThrowsTurnAbort) {
        const err = new Error("Turn aborted: ui-chat-abort") as Error & {
          code?: string;
        };
        err.name = "TurnAbortedError";
        err.code = "TURN_ABORTED";
        throw err;
      }
      if (generateThrowsTimeout) {
        const incomingMessage: Memory = {
          id: stringToUuid("user-msg-store"),
          entityId: stringToUuid("admin-1"),
          agentId: stringToUuid("agent-1"),
          roomId: stringToUuid("room-1"),
          content: { text: "hello" },
        };
        opts?.onIncomingMessagePersisted?.(incomingMessage);
        if (assistantMemoryAlreadyPersisted) {
          opts?.onResponseMessagePersisted?.({
            id: stringToUuid("already-persisted-assistant"),
            entityId: stringToUuid("agent-1"),
            agentId: stringToUuid("agent-1"),
            roomId: stringToUuid("room-1"),
            content: { text: "Already persisted exact reply" },
          });
        }
        throw new Error("Chat generation timed out after 180000ms");
      }
      if (generateWaitsForAbort) {
        await new Promise<void>((resolve) => {
          opts?.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("aborted");
      }
      // Stream a single token so the SSE wire format mirrors a real turn.
      opts?.onChunk?.("ok");
      const persistedRequestMessageId = stringToUuid("user-msg-store");
      opts?.onIncomingMessagePersisted?.({
        id: persistedRequestMessageId,
        entityId: stringToUuid("admin-1"),
        agentId: stringToUuid("agent-1"),
        roomId: stringToUuid("room-1"),
        content: { text: "hello" },
      });
      return {
        text: "ok",
        agentName,
        persistedRequestMessageId,
        usage: undefined,
        usedActionCallbacks: false,
        actionCallbackHistory: undefined,
        noResponseReason: undefined,
      };
    }),
    normalizeChatResponseText: (text: string) => text,
    resolveNoResponseFallback: () => "",
  };
});

// `buildUserMessages` and other helpers in server-helpers.ts dive into runtime
// internals; replace the surface the handler actually needs.
vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    buildUserMessages: vi.fn(({ prompt, userId, agentId, roomId }) => ({
      userMessage: {
        id: stringToUuid("user-msg"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
      messageToStore: {
        id: stringToUuid("user-msg-store"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
    })),
    resolveWalletModeGuidanceReply: () => null,
    resolveAppUserName: () => "tester",
  };
});

// Skip world ownership writes — they touch the adapter this fixture does not provide.
vi.mock("../character-routes.ts", async () => {
  const actual = await vi
    .importActual<Record<string, unknown>>("../character-routes.ts")
    .catch(() => ({}));
  return actual;
});

import {
  persistAssistantConversationMemory,
  readChatRequestPayload,
} from "../chat-routes.ts";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import { handleConversationRoutes } from "../conversation-routes.ts";

interface MockResponseRecord {
  writes: string[];
  ended: boolean;
  endedAt: number | null;
}

type MockSocket = EventEmitter & {
  destroyed: boolean;
  writable: boolean;
};

function createMockSocket(): MockSocket {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
  });
}

function createMockReq(socket: MockSocket): http.IncomingMessage {
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method: "POST",
    url: "/api/conversations/conv-1/messages/stream",
    headers: {},
  });
  Object.defineProperty(req, "socket", {
    configurable: true,
    value: socket,
  });
  return req as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = {
    writes: [],
    ended: false,
    endedAt: null,
  };
  // We don't need a real ServerResponse; only the methods the handler calls.
  const responseFixture = {
    setHeader: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      record.writes.push(text);
      return true;
    }),
    end: vi.fn(() => {
      record.ended = true;
      record.endedAt = Date.now();
    }),
    writableEnded: false,
  } as unknown as http.ServerResponse;
  return { res: responseFixture, record };
}

function createState(): ConversationRouteState {
  const roomId = stringToUuid("room-1") as UUID;
  const adminId = stringToUuid("admin-1") as UUID;
  const conv = {
    id: "conv-1",
    title: "Test conv",
    roomId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const runtime = {
    agentId: stringToUuid("agent-1"),
    character: { name: "Test Agent" },
    logger,
    ensureConnection: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => null),
    adapter: {},
  };
  return {
    runtime: runtime as never,
    config: { user: { name: "tester" } } as never,
    agentName: "Test Agent",
    adminEntityId: adminId,
    chatUserId: adminId,
    logBuffer: [],
    conversations: new Map([[conv.id, conv]]),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  };
}

function createCtx(): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  state: ConversationRouteState;
  socket: MockSocket;
} {
  const socket = createMockSocket();
  const req = createMockReq(socket);
  const { res, record } = createMockRes();
  const state = createState();
  const ctx: ConversationRouteContext = {
    req,
    res,
    method: "POST",
    pathname: "/api/conversations/conv-1/messages/stream",
    state,
    readJsonBody: vi.fn(async () => ({ prompt: "hello" })),
    json: vi.fn(),
    error: vi.fn((response, message, status) => {
      response.write(`error ${status}: ${message}`);
      response.end();
    }),
  } as unknown as ConversationRouteContext;
  return { ctx, record, state, socket };
}

describe("conversation-routes streaming persistence ordering", () => {
  beforeEach(() => {
    persistResolve = null;
    persistReject = null;
    persistCalledAt = null;
    persistResolvedAt = null;
    captureGenerateAbortSignal = undefined;
    generateWaitsForAbort = false;
    generateThrowsTurnAbort = false;
    generateThrowsTimeout = false;
    assistantMemoryAlreadyPersisted = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits `done` and ends only AFTER persistence resolves", async () => {
    const { ctx, record } = createCtx();

    // Kick the handler off; do NOT await — persistence is hanging.
    const handlerDone = handleConversationRoutes(ctx);

    // Yield repeatedly so the handler reaches the pending persistence write.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(record.writes.some((w) => w.includes('"type":"done"'))).toBe(false);
    expect(record.ended).toBe(false);
    expect(persistCalledAt).not.toBeNull();
    expect(persistResolvedAt).toBeNull();

    // Once persistence commits, the route can truthfully emit the terminal ids.
    persistResolve?.();
    await handlerDone;
    expect(persistResolvedAt).not.toBeNull();
    const doneFrame = record.writes.find((w) => w.includes('"type":"done"'));
    expect(doneFrame).toContain(
      `"messageId":"${stringToUuid("assistant-msg-store")}"`,
    );
    expect(doneFrame).toContain(
      `"userMessageId":"${stringToUuid("user-msg-store")}"`,
    );
    expect(record.ended).toBe(true);
    expect(record.endedAt).not.toBeNull();
    expect(record.endedAt ?? 0).toBeGreaterThanOrEqual(persistResolvedAt ?? 0);
  });

  it("turns persistence failures into a terminal SSE error", async () => {
    const { ctx, record } = createCtx();

    const handlerDone = handleConversationRoutes(ctx);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(record.ended).toBe(false);
    const persistErr = new Error("simulated db failure");
    persistReject?.(persistErr);
    await handlerDone;
    expect(record.writes.some((w) => w.includes('"type":"done"'))).toBe(false);
    expect(record.writes.join("")).toContain('"type":"error"');
    expect(record.writes.join("")).toContain("simulated db failure");
    expect(record.ended).toBe(true);
  });

  it("aborts generation when the client socket closes after request body parsing", async () => {
    generateWaitsForAbort = true;
    const { ctx, record, socket } = createCtx();

    vi.mocked(readChatRequestPayload).mockImplementationOnce(async () => {
      // Bun emits req.close when the POST body finishes. This must not abort
      // the SSE turn, but the already-installed socket listener must still see
      // a later client disconnect.
      ctx.req.emit("close");
      return {
        prompt: "hello",
        channelType: ChannelType.DM,
        images: undefined,
        preferredLanguage: undefined,
        source: "api",
        metadata: undefined,
      };
    });

    const handlerDone = handleConversationRoutes(ctx);
    for (let i = 0; i < 10 && !captureGenerateAbortSignal; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(captureGenerateAbortSignal).toBeDefined();
    expect(captureGenerateAbortSignal?.aborted).toBe(false);

    socket.destroyed = true;
    socket.writable = false;
    socket.emit("close");

    await handlerDone;
    expect(captureGenerateAbortSignal?.aborted).toBe(true);
    expect(record.ended).toBe(true);
  });

  it("ends the stream without fallback generation when the turn is aborted externally", async () => {
    generateThrowsTurnAbort = true;
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    expect(record.ended).toBe(true);
    expect(record.writes.some((w) => w.includes('"type":"done"'))).toBe(false);
    expect(record.writes.some((w) => w.includes('"type":"error"'))).toBe(false);
    expect(persistCalledAt).toBeNull();
  });

  it("reuses the exact observed assistant receipt when later work times out", async () => {
    generateThrowsTimeout = true;
    assistantMemoryAlreadyPersisted = true;
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
    expect(record.writes.some((w) => w.includes('"type":"done"'))).toBe(true);
    expect(record.writes.join("")).toContain("Already persisted exact reply");
    expect(record.writes.join("")).toContain(
      stringToUuid("already-persisted-assistant"),
    );
    expect(record.ended).toBe(true);
  });
});
