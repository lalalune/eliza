/**
 * Drives shared-turn queueing, completion, retry, and goal extraction through
 * the real Drizzle repository and an in-process Postgres implementation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_ID = "room-activation";
const LEASE_MS = 300_000;

let databaseReady = true;
let dbWrite: typeof import("../client").dbWrite;
let closeDb: typeof import("../client").closeDatabaseConnectionsForTests;
let repository: typeof import("./shared-runtime-turn-claims").sharedRuntimeTurnClaimsRepository;
let agentActivationGreetings: typeof import("../schemas/agent-activation-greetings").agentActivationGreetings;
let agentSandboxes: typeof import("../schemas/agent-sandboxes").agentSandboxes;
let organizations: typeof import("../schemas/organizations").organizations;
let sharedRuntimeHistory: typeof import("../schemas/shared-runtime-history").sharedRuntimeHistory;
let sharedRuntimeTurnClaims: typeof import("../schemas/shared-runtime-turn-claims").sharedRuntimeTurnClaims;
let userCharacters: typeof import("../schemas/user-characters").userCharacters;
let users: typeof import("../schemas/users").users;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../client"));
    ({ agentActivationGreetings } = await import("../schemas/agent-activation-greetings"));
    ({ agentSandboxes } = await import("../schemas/agent-sandboxes"));
    ({ organizations } = await import("../schemas/organizations"));
    ({ sharedRuntimeHistory } = await import("../schemas/shared-runtime-history"));
    ({ sharedRuntimeTurnClaims } = await import("../schemas/shared-runtime-turn-claims"));
    ({ userCharacters } = await import("../schemas/user-characters"));
    ({ users } = await import("../schemas/users"));
    ({ sharedRuntimeTurnClaimsRepository: repository } = await import(
      "./shared-runtime-turn-claims"
    ));
    const { pushSchemaToTestDb } = await import("../push-schema-for-tests");
    await pushSchemaToTestDb({
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentActivationGreetings,
      sharedRuntimeHistory,
      sharedRuntimeTurnClaims,
    });
  } catch (error) {
    databaseReady = false;
    console.error("[shared-runtime-turn-claims.integration] setup failed", error);
  }
}, 120_000);

beforeEach(async () => {
  expect(databaseReady).toBe(true);
  await dbWrite.delete(sharedRuntimeTurnClaims);
  await dbWrite.delete(agentActivationGreetings);
  await dbWrite.delete(sharedRuntimeHistory);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite.insert(organizations).values({
    id: ORG_ID,
    name: "Shared Turn Test",
    slug: "shared-turn-test",
  });
  await dbWrite.insert(users).values({
    id: OWNER_ID,
    organization_id: ORG_ID,
    steward_user_id: "shared-turn-owner",
    role: "owner",
  });
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORG_ID,
    user_id: OWNER_ID,
    agent_name: "Eliza",
    execution_tier: "shared",
    status: "running",
  });
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

function claimInput(
  clientMessageId: string,
  claimToken: string,
  ownerText = "Help me ship the iOS app by September.",
) {
  return {
    agentId: AGENT_ID,
    channelId: ROOM_ID,
    clientMessageId,
    assistantMessageId:
      clientMessageId === "turn-a"
        ? "44444444-4444-4444-8444-444444444444"
        : "55555555-5555-4555-8555-555555555555",
    ownerText,
    claimToken,
    leaseMs: LEASE_MS,
  };
}

describe("SharedRuntimeTurnClaimsRepository", () => {
  test("one requester runs a stable-id turn and every retry reads its committed reply", async () => {
    const first = await repository.acquire(
      claimInput("turn-a", "66666666-6666-4666-8666-666666666666"),
    );
    expect(first).toMatchObject({ status: "claimed", history: [] });

    const concurrentRetry = await repository.acquire(
      claimInput("turn-a", "77777777-7777-4777-8777-777777777777"),
    );
    expect(concurrentRetry).toEqual({ status: "waiting" });

    const completed = await repository.complete({
      ...claimInput("turn-a", "66666666-6666-4666-8666-666666666666"),
      assistantText: "I can help make that deadline concrete.",
      ownerCreatedAt: 1_785_000_000_000,
      assistantCreatedAt: 1_785_000_000_001,
      maxMessages: 40,
    });
    expect(completed).toEqual({
      assistantReply: "I can help make that deadline concrete.",
      persisted: true,
    });

    const retry = await repository.acquire(
      claimInput("turn-a", "88888888-8888-4888-8888-888888888888"),
    );
    expect(retry).toEqual({
      status: "completed",
      assistantReply: "I can help make that deadline concrete.",
    });

    const [history] = await dbWrite.select().from(sharedRuntimeHistory);
    expect(history.messages).toEqual([
      {
        id: "turn-a",
        role: "user",
        content: "Help me ship the iOS app by September.",
        createdAt: 1_785_000_000_000,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        role: "assistant",
        content: "I can help make that deadline concrete.",
        createdAt: 1_785_000_000_001,
      },
    ]);
  });

  test("distinct turns serialize and the next model receives the committed history", async () => {
    const first = await repository.acquire(
      claimInput("turn-a", "66666666-6666-4666-8666-666666666666"),
    );
    expect(first.status).toBe("claimed");
    const secondWaiting = await repository.acquire(
      claimInput(
        "turn-b",
        "77777777-7777-4777-8777-777777777777",
        "Also preserve the Android launch.",
      ),
    );
    expect(secondWaiting).toEqual({ status: "waiting" });

    await repository.complete({
      ...claimInput("turn-a", "66666666-6666-4666-8666-666666666666"),
      assistantText: "We will track the iOS milestone.",
      ownerCreatedAt: 100,
      assistantCreatedAt: 101,
      maxMessages: 40,
    });
    const second = await repository.acquire(
      claimInput(
        "turn-b",
        "77777777-7777-4777-8777-777777777777",
        "Also preserve the Android launch.",
      ),
    );
    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") throw new Error("second turn was not claimed");
    expect(second.history.map((message) => message.content)).toEqual([
      "Help me ship the iOS app by September.",
      "We will track the iOS milestone.",
    ]);
  });

  test("completion stores accepted activation goal and transcript in one commit", async () => {
    await dbWrite.insert(agentActivationGreetings).values({
      agent_id: AGENT_ID,
      owner_user_id: OWNER_ID,
      activation_version: "1",
      conversation_id: ROOM_ID,
      message_id: "99999999-9999-4999-8999-999999999999",
      source: "agent_greeting",
      greeting_kind: "post_sign_in_activation",
      text: "How would you like to get started?",
      agent_name: "Eliza",
      projected_at: new Date(),
    });
    await repository.acquire(claimInput("turn-a", "66666666-6666-4666-8666-666666666666"));
    await repository.complete({
      ...claimInput("turn-a", "66666666-6666-4666-8666-666666666666"),
      assistantText: "I will help you ship it.",
      ownerCreatedAt: 100,
      assistantCreatedAt: 101,
      maxMessages: 40,
      activation: {
        ownerUserId: OWNER_ID,
        activationVersion: "1",
        extractionModel: "live-model",
        extraction: {
          goalFound: true,
          goal: "Ship the iOS app by September",
          confidence: 0.95,
        },
      },
    });

    const [activation] = await dbWrite
      .select()
      .from(agentActivationGreetings)
      .where(eq(agentActivationGreetings.agent_id, AGENT_ID));
    expect(activation).toMatchObject({
      goal_status: "accepted",
      response_message_id: "turn-a",
      response_text: "Help me ship the iOS app by September.",
      goal_text: "Ship the iOS app by September",
      goal_confidence: 0.95,
      goal_model: "live-model",
    });
    expect(activation.goal_recorded_at).toBeInstanceOf(Date);
  });

  test("reusing a stable id with different text fails closed", async () => {
    await repository.acquire(claimInput("turn-a", "66666666-6666-4666-8666-666666666666"));
    await expect(
      repository.acquire(
        claimInput(
          "turn-a",
          "77777777-7777-4777-8777-777777777777",
          "A different request under the same id",
        ),
      ),
    ).rejects.toMatchObject({ code: "SHARED_TURN_IDEMPOTENCY_CONFLICT" });
  });

  test("handoff waits for an admitted turn, fences the exact snapshot, and releases on failure", async () => {
    const processing = await repository.acquire(
      claimInput("turn-a", "66666666-6666-4666-8666-666666666666"),
    );
    expect(processing.status).toBe("claimed");

    const whileProcessing = await repository.beginHandoffSnapshot({
      agentId: AGENT_ID,
      channelId: ROOM_ID,
      ownerUserId: OWNER_ID,
      activationVersion: "1",
      fenceToken: "99999999-9999-4999-8999-999999999999",
      leaseMs: LEASE_MS,
    });
    expect(whileProcessing.ready).toBe(false);

    await repository.complete({
      ...claimInput("turn-a", "66666666-6666-4666-8666-666666666666"),
      assistantText: "The final shared reply.",
      ownerCreatedAt: 100,
      assistantCreatedAt: 101,
      maxMessages: 40,
    });
    const snapshot = await repository.beginHandoffSnapshot({
      agentId: AGENT_ID,
      channelId: ROOM_ID,
      ownerUserId: OWNER_ID,
      activationVersion: "1",
      fenceToken: "99999999-9999-4999-8999-999999999999",
      leaseMs: LEASE_MS,
    });
    expect(snapshot).toMatchObject({
      ready: true,
      messages: [
        { id: "turn-a", content: "Help me ship the iOS app by September." },
        {
          id: "44444444-4444-4444-8444-444444444444",
          content: "The final shared reply.",
        },
      ],
    });

    const blocked = await repository.acquire(
      claimInput(
        "turn-b",
        "77777777-7777-4777-8777-777777777777",
        "This must wait for the dedicated runtime.",
      ),
    );
    expect(blocked.status).toBe("handoff-fenced");

    expect(
      await repository.releaseHandoffFence({
        agentId: AGENT_ID,
        channelId: ROOM_ID,
        fenceToken: "99999999-9999-4999-8999-999999999999",
      }),
    ).toBe(true);
    const afterRelease = await repository.acquire(
      claimInput(
        "turn-b",
        "77777777-7777-4777-8777-777777777777",
        "This must wait for the dedicated runtime.",
      ),
    );
    expect(afterRelease.status).toBe("claimed");
  });
});
