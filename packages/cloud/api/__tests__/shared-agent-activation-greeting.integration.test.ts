/**
 * Real Worker-route and PGlite coverage for shared-agent greeting delivery.
 *
 * Auth resolution is the only substituted boundary; the Hono routes, greeting
 * use-cases, Drizzle repositories, constraints, transcript projection, and
 * concurrent database writes all run for real against one in-process Postgres.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { stringToUuid } from "@elizaos/core";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const CANONICAL_ROOM = AGENT_ID;
const FORGED_ROOM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTIVATION_TEXT =
  "You’re signed in — I’m ready. What would you like to work on first? If you’ve got a problem you want to solve, tell me what’s going on.";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let resolvedAgentName = "Eliza";
const resolveSharedAgent = mock(
  async (c: {
    req: {
      header(name: string): string | undefined;
      param(name: string): string | undefined;
    };
  }) => {
    const callerUserId =
      c.req.header("x-test-caller") === "member" ? MEMBER_ID : OWNER_ID;
    return {
      agent: {
        id: AGENT_ID,
        organization_id: ORG_ID,
        user_id: OWNER_ID,
        agent_name: resolvedAgentName,
        execution_tier: "shared",
        status: "running",
        created_at: new Date("2026-07-23T00:00:00.000Z"),
      },
      agentId: c.req.param("agentId") ?? AGENT_ID,
      orgId: ORG_ID,
      agentName: resolvedAgentName,
      callerUserId,
    };
  },
);

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedAgent,
}));

let app: Hono<AppEnv>;
let closeDb: (() => Promise<void>) | undefined;
let dbWrite: typeof import("@/db/client").dbWrite;
let agentActivationGreetings: typeof import("@/db/schemas/agent-activation-greetings").agentActivationGreetings;
let sharedRuntimeHistory: typeof import("@/db/schemas/shared-runtime-history").sharedRuntimeHistory;
let sharedRuntimeHistoryRepository: typeof import("@/db/repositories/shared-runtime-history").sharedRuntimeHistoryRepository;
let sharedRuntimeTurnClaims: typeof import("@/db/schemas/shared-runtime-turn-claims").sharedRuntimeTurnClaims;
let sharedRuntimeTurnClaimsRepository: typeof import("@/db/repositories/shared-runtime-turn-claims").sharedRuntimeTurnClaimsRepository;
let getSharedConversationChannelId: (agentId: string, roomId: string) => string;
let pgliteReady = true;

beforeAll(async () => {
  try {
    const client = await import("@/db/client");
    dbWrite = client.dbWrite;
    closeDb = client.closeDatabaseConnectionsForTests;
    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    ({ agentActivationGreetings } = await import(
      "@/db/schemas/agent-activation-greetings"
    ));
    ({ sharedRuntimeHistory } = await import(
      "@/db/schemas/shared-runtime-history"
    ));
    ({ sharedRuntimeHistoryRepository } = await import(
      "@/db/repositories/shared-runtime-history"
    ));
    ({ sharedRuntimeTurnClaims } = await import(
      "@/db/schemas/shared-runtime-turn-claims"
    ));
    ({ sharedRuntimeTurnClaimsRepository } = await import(
      "@/db/repositories/shared-runtime-turn-claims"
    ));
    const { pushSchemaToTestDb } = await import("@/db/push-schema-for-tests");
    await pushSchemaToTestDb({
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentActivationGreetings,
      sharedRuntimeHistory,
      sharedRuntimeTurnClaims,
    });

    await dbWrite.insert(organizations).values({
      id: ORG_ID,
      name: "Activation Test Org",
      slug: "activation-test-org",
    });
    await dbWrite.insert(users).values([
      {
        id: OWNER_ID,
        organization_id: ORG_ID,
        steward_user_id: "steward-activation-owner",
        role: "owner",
      },
      {
        id: MEMBER_ID,
        organization_id: ORG_ID,
        steward_user_id: "steward-activation-member",
        role: "member",
      },
    ]);
    await dbWrite.insert(agentSandboxes).values({
      id: AGENT_ID,
      organization_id: ORG_ID,
      user_id: OWNER_ID,
      agent_name: resolvedAgentName,
      execution_tier: "shared",
      status: "running",
    });

    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    getSharedConversationChannelId = (agentId, roomId) =>
      elizaSandboxService.getSharedConversationChannelId(agentId, roomId);

    const greetingRoute = (
      await import(
        "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/greeting/route"
      )
    ).default;
    const messagesRoute = (
      await import(
        "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/route"
      )
    ).default;
    const handoffRoute = (
      await import(
        "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/handoff/route"
      )
    ).default;
    const conversationRoute = (
      await import(
        "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/route"
      )
    ).default;

    app = new Hono<AppEnv>();
    app.route(
      "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/greeting",
      greetingRoute,
    );
    app.route(
      "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages",
      messagesRoute,
    );
    app.route(
      "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages/handoff",
      handoffRoute,
    );
    app.route(
      "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId",
      conversationRoute,
    );
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[shared-agent-activation-greeting.integration] real PGlite setup failed",
      error,
    );
  }
}, 120_000);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  resolvedAgentName = "Eliza";
  await dbWrite.delete(sharedRuntimeTurnClaims);
  await dbWrite.delete(agentActivationGreetings);
  await dbWrite.delete(sharedRuntimeHistory);
});

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
});

function endpoint(roomId: string, suffix = ""): string {
  return `/api/v1/eliza/agents/${AGENT_ID}/api/conversations/${roomId}${suffix}`;
}

function requestGreeting(
  roomId: string,
  greetingKind?: string,
  caller: "owner" | "member" = "owner",
): Response | Promise<Response> {
  const query =
    greetingKind === undefined
      ? ""
      : `?greetingKind=${encodeURIComponent(greetingKind)}`;
  return app.request(
    `${endpoint(roomId, "/greeting")}${query}`,
    {
      method: "POST",
      headers: { "X-Test-Caller": caller },
    },
    ENV,
  );
}

function requestHandoff(
  method: "POST" | "DELETE",
  fenceToken: string,
  caller: "owner" | "member" = "owner",
): Response | Promise<Response> {
  return app.request(
    endpoint(CANONICAL_ROOM, "/messages/handoff"),
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Test-Caller": caller,
      },
      body: JSON.stringify({ fenceToken }),
    },
    ENV,
  );
}

async function getMessages(
  roomId: string,
  caller: "owner" | "member" = "owner",
): Promise<Array<Record<string, unknown>>> {
  const response = await app.request(
    endpoint(roomId, "/messages"),
    {
      method: "GET",
      headers: { "X-Test-Caller": caller },
    },
    ENV,
  );
  expect(response.status).toBe(200);
  return (
    (await response.json()) as { messages: Array<Record<string, unknown>> }
  ).messages;
}

describe("shared-agent greeting Worker routes with a real database", () => {
  test("ordinary greeting seeds the one canonical room and rejects hidden rooms", async () => {
    const first = await requestGreeting(CANONICAL_ROOM);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      text: "Hey, I'm Eliza. What can I help you with?",
      agentName: "Eliza",
      generated: true,
      persisted: true,
    });

    const retry = await requestGreeting(CANONICAL_ROOM, "conversation");
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({
      text: "Hey, I'm Eliza. What can I help you with?",
      agentName: "Eliza",
      generated: true,
      persisted: false,
    });

    const canonicalMessages = await getMessages(CANONICAL_ROOM);
    expect(canonicalMessages).toEqual([
      {
        id: stringToUuid(`conversation-greeting:${AGENT_ID}:${CANONICAL_ROOM}`),
        role: "assistant",
        text: "Hey, I'm Eliza. What can I help you with?",
        timestamp: expect.any(Number),
        source: "agent_greeting",
        greetingKind: "conversation",
      },
    ]);

    const hiddenRoomResponses = await Promise.all(
      Array.from({ length: 8 }, () => requestGreeting(FORGED_ROOM)),
    );
    expect(
      hiddenRoomResponses.every((response) => response.status === 404),
    ).toBe(true);
    const hiddenRoomBodies = (await Promise.all(
      hiddenRoomResponses.map((response) => response.json()),
    )) as Array<Record<string, unknown>>;
    expect(hiddenRoomBodies).toEqual(
      Array.from({ length: 8 }, () => ({
        success: false,
        error: "Conversation not found",
        code: "conversation_not_found",
      })),
    );
    expect(await dbWrite.select().from(sharedRuntimeHistory)).toHaveLength(1);
  });

  test("ordinary greeting does not overwrite or append to a non-empty room", async () => {
    const channelId = getSharedConversationChannelId(AGENT_ID, CANONICAL_ROOM);
    await sharedRuntimeHistoryRepository.upsert(AGENT_ID, channelId, [
      {
        role: "user",
        content: "Existing problem",
        createdAt: Date.now() - 1_000,
      },
    ]);

    const response = await requestGreeting(CANONICAL_ROOM);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "",
      agentName: "Eliza",
      generated: false,
      persisted: false,
    });
    expect(await getMessages(CANONICAL_ROOM)).toEqual([
      {
        id: `${CANONICAL_ROOM}:0`,
        role: "user",
        text: "Existing problem",
        timestamp: expect.any(Number),
      },
    ]);
  });

  test("concurrent activation requests commit one stable canonical message", async () => {
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        requestGreeting(CANONICAL_ROOM, "post_sign_in_activation"),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<Record<string, unknown>>;
    const expectedMessageId = stringToUuid(
      `post-sign-in-activation:${AGENT_ID}:${OWNER_ID}:1`,
    );

    expect(new Set(bodies.map((body) => body.messageId))).toEqual(
      new Set([expectedMessageId]),
    );
    expect(new Set(bodies.map((body) => body.timestamp)).size).toBe(1);
    expect(bodies.filter((body) => body.persisted === true)).toHaveLength(1);
    expect(bodies.filter((body) => body.text === ACTIVATION_TEXT)).toHaveLength(
      1,
    );
    for (const body of bodies) {
      expect(body).toEqual({
        text: body.persisted === true ? ACTIVATION_TEXT : "",
        agentName: "Eliza",
        generated: body.persisted === true,
        persisted: expect.any(Boolean),
        messageId: expectedMessageId,
        source: "agent_greeting",
        timestamp: expect.any(Number),
        greetingKind: "post_sign_in_activation",
        activationVersion: "1",
        conversationId: CANONICAL_ROOM,
      });
    }

    const rows = await dbWrite.select().from(agentActivationGreetings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: AGENT_ID,
      owner_user_id: OWNER_ID,
      activation_version: "1",
      message_id: expectedMessageId,
      source: "agent_greeting",
      greeting_kind: "post_sign_in_activation",
      text: ACTIVATION_TEXT,
      projected_at: expect.any(Date),
    });
    expect(rows[0].conversation_id).toBe(CANONICAL_ROOM);

    const winnerMessages = await getMessages(rows[0].conversation_id);
    expect(winnerMessages).toContainEqual({
      id: expectedMessageId,
      role: "assistant",
      text: ACTIVATION_TEXT,
      timestamp: rows[0].created_at.getTime(),
      source: "agent_greeting",
      greetingKind: "post_sign_in_activation",
      activationVersion: "1",
    });
  });

  test("activation appends to existing history and does not replay after deletion", async () => {
    await requestGreeting(CANONICAL_ROOM);
    const activation = await requestGreeting(
      CANONICAL_ROOM,
      "post_sign_in_activation",
    );
    expect(activation.status).toBe(200);
    const activationBody = (await activation.json()) as Record<string, unknown>;

    const beforeDelete = await getMessages(CANONICAL_ROOM);
    expect(beforeDelete.map((message) => message.greetingKind)).toEqual([
      "conversation",
      "post_sign_in_activation",
    ]);

    const deleted = await app.request(
      endpoint(CANONICAL_ROOM),
      {
        method: "DELETE",
        headers: { "X-Test-Caller": "owner" },
      },
      ENV,
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });

    // Shared conversations are currently derived/no-op deletes. Remove the
    // replaceable transcript row as the stronger deletion boundary: the global
    // ledger must prevent the activation from replaying with the ordinary room
    // history correctly gone.
    await dbWrite.delete(sharedRuntimeHistory);
    resolvedAgentName = "Renamed Agent";
    const retry = await requestGreeting(
      CANONICAL_ROOM,
      "post_sign_in_activation",
    );
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as Record<string, unknown>;
    expect(retryBody).toMatchObject({
      messageId: activationBody.messageId,
      timestamp: activationBody.timestamp,
      conversationId: activationBody.conversationId,
      text: "",
      generated: false,
      persisted: false,
    });
    expect(await getMessages(CANONICAL_ROOM)).toEqual([]);
    expect(await dbWrite.select().from(agentActivationGreetings)).toHaveLength(
      1,
    );
  });

  test("a same-organization non-owner cannot create or read activation", async () => {
    const denied = await requestGreeting(
      CANONICAL_ROOM,
      "post_sign_in_activation",
      "member",
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      success: false,
      error: "Only the agent owner can request post-sign-in activation",
      code: "owner_required",
    });
    expect(await dbWrite.select().from(agentActivationGreetings)).toEqual([]);

    const ownerActivation = await requestGreeting(
      CANONICAL_ROOM,
      "post_sign_in_activation",
    );
    expect(ownerActivation.status).toBe(200);
    expect(await getMessages(CANONICAL_ROOM, "member")).toEqual([]);

    const invalid = await requestGreeting(CANONICAL_ROOM, "surprise");
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      success: false,
      code: "invalid_greeting_kind",
    });
  });

  test("a forged room cannot burn the activation ledger", async () => {
    const forged = await requestGreeting(
      FORGED_ROOM,
      "post_sign_in_activation",
    );
    expect(forged.status).toBe(404);
    await expect(forged.json()).resolves.toEqual({
      success: false,
      error: "Conversation not found",
      code: "conversation_not_found",
    });
    expect(await dbWrite.select().from(agentActivationGreetings)).toEqual([]);
    expect(await dbWrite.select().from(sharedRuntimeHistory)).toEqual([]);

    const canonical = await requestGreeting(
      CANONICAL_ROOM,
      "post_sign_in_activation",
    );
    expect(canonical.status).toBe(200);
    await expect(canonical.json()).resolves.toMatchObject({
      text: ACTIVATION_TEXT,
      persisted: true,
      conversationId: CANONICAL_ROOM,
    });
  });

  test("owner-only handoff waits for an admitted turn, fences one snapshot, and releases", async () => {
    await requestGreeting(CANONICAL_ROOM, "post_sign_in_activation");
    const channelId = getSharedConversationChannelId(AGENT_ID, CANONICAL_ROOM);
    const ownerText = "Help me ship iOS by September.";
    const clientMessageId = "shared-handoff-turn";
    const assistantMessageId = stringToUuid(
      `shared-assistant:${clientMessageId}`,
    );
    const claimToken = "77777777-7777-4777-8777-777777777777";
    const claimed = await sharedRuntimeTurnClaimsRepository.acquire({
      agentId: AGENT_ID,
      channelId,
      clientMessageId,
      assistantMessageId,
      ownerText,
      claimToken,
      leaseMs: 300_000,
    });
    expect(claimed.status).toBe("claimed");

    const fenceToken = "88888888-8888-4888-8888-888888888888";
    const busy = await requestHandoff("POST", fenceToken);
    expect(busy.status).toBe(425);
    await expect(busy.json()).resolves.toMatchObject({
      code: "handoff_not_quiescent",
      retryable: true,
    });

    await sharedRuntimeTurnClaimsRepository.complete({
      agentId: AGENT_ID,
      channelId,
      clientMessageId,
      assistantMessageId,
      ownerText,
      assistantText: "I can help make that concrete.",
      ownerCreatedAt: 1_785_000_000_000,
      assistantCreatedAt: 1_785_000_000_001,
      claimToken,
      maxMessages: 40,
      activation: {
        ownerUserId: OWNER_ID,
        activationVersion: "1",
        extractionModel: "live-model",
        extraction: {
          goalFound: true,
          goal: "Ship iOS by September",
          confidence: 0.95,
        },
      },
    });

    const denied = await requestHandoff("POST", fenceToken, "member");
    expect(denied.status).toBe(403);
    const snapshot = await requestHandoff("POST", fenceToken);
    expect(snapshot.status).toBe(200);
    const snapshotBody = (await snapshot.json()) as {
      messages: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    expect(snapshotBody).toMatchObject({
      success: true,
      fenceToken,
      activationGoal: {
        status: "accepted",
        goal: { text: "Ship iOS by September", confidence: 0.95 },
      },
    });
    expect(snapshotBody.messages).toContainEqual(
      expect.objectContaining({
        id: clientMessageId,
        role: "user",
        text: ownerText,
      }),
    );
    expect(snapshotBody.messages).toContainEqual(
      expect.objectContaining({
        id: assistantMessageId,
        role: "assistant",
        text: "I can help make that concrete.",
      }),
    );

    const blocked = await sharedRuntimeTurnClaimsRepository.acquire({
      agentId: AGENT_ID,
      channelId,
      clientMessageId: "turn-after-fence",
      assistantMessageId: "99999999-9999-4999-8999-999999999999",
      ownerText: "This turn belongs on dedicated.",
      claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      leaseMs: 300_000,
    });
    expect(blocked.status).toBe("handoff-fenced");

    const released = await requestHandoff("DELETE", fenceToken);
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({
      success: true,
      released: true,
    });
  });
});
