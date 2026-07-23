/**
 * Service-key agent message route coverage with deterministic Worker fixtures.
 * The suite proves wallet-owned routing, reply polling, and deferred web-push
 * sender wiring without standing up the daemon bridge.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
interface TestAgent {
  id: string;
  organization_id: string;
  user_id: string;
  execution_tier?: "shared" | "dedicated";
  agent_name?: string;
}
const getAgentById = mock(
  async (_agentId: string): Promise<TestAgent | null> => ({
    id: "cloud-agent-1",
    organization_id: "agent-wallet-org",
    user_id: "agent-wallet-user",
  }),
);
const resolveServiceAgent = mock(
  async ({
    agentId,
  }: {
    agentId: string;
  }): Promise<{ agent?: TestAgent | null; retryable?: boolean }> => ({
    agent: await getAgentById(agentId),
  }),
);
type TestBridgeResponse =
  | {
      jsonrpc: "2.0";
      result: { text: string; reason: string };
    }
  | {
      jsonrpc: "2.0";
      error: { code: number; message: string };
    };
const bridgeResolvedShared = mock(
  async (): Promise<TestBridgeResponse> => ({
    jsonrpc: "2.0" as const,
    result: {
      text: "shared reply",
      reason: "ok",
    },
  }),
);
const enqueueAgentMessage = mock(async () => ({
  created: true,
  job: {
    id: "message-job-1",
    status: "pending",
  },
}));
const triggerImmediate = mock(async () => undefined);
const getJobForOrg = mock(async () => ({
  id: "message-job-1",
  status: "completed",
  result: {
    text: "hello back",
    reason: "ok",
  },
}));
const notifyAgentReply = mock(async () => ({
  pushed: false,
  reason: "unconfigured" as const,
}));

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  BRIDGE_CACHE_WARMING_CODE: -32003,
  elizaSandboxService: {
    getAgentById,
    bridgeResolvedShared,
  },
}));

mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    resolveServiceAgent,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentMessage,
    getJobForOrg,
    triggerImmediate,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

mock.module("@/lib/web-push", () => ({
  notifyAgentReply,
}));

const { default: messageRoute } = await import("./route");

describe("service agent message route", () => {
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/message", messageRoute);

  beforeEach(() => {
    requireServiceKey.mockClear();
    getAgentById.mockClear();
    getAgentById.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-wallet-org",
      user_id: "agent-wallet-user",
    });
    resolveServiceAgent.mockClear();
    resolveServiceAgent.mockImplementation(async ({ agentId }) => ({
      agent: await getAgentById(agentId),
    }));
    bridgeResolvedShared.mockClear();
    enqueueAgentMessage.mockClear();
    enqueueAgentMessage.mockResolvedValue({
      created: true,
      job: {
        id: "message-job-1",
        status: "pending",
      },
    });
    triggerImmediate.mockClear();
    notifyAgentReply.mockClear();
    getJobForOrg.mockClear();
    getJobForOrg.mockResolvedValue({
      id: "message-job-1",
      status: "completed",
      result: {
        text: "hello back",
        reason: "ok",
      },
    });
  });

  test("routes wallet-owned agents through the agent owner org and user", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/message",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({
            text: "hello",
            userId: "patron-user",
            sessionId: "session-1",
            roomId: "room-1",
          }),
        },
      ),
      {
        WAIFU_SERVICE_KEY: "svc",
        ELIZA_WEB_PUSH_VAPID_PUBLIC_KEY: "PUBKEY",
        ELIZA_WEB_PUSH_VAPID_PRIVATE_KEY: "PRIVKEY",
      },
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      text: "hello back",
      reason: "ok",
      jobId: "message-job-1",
    });

    expect(getAgentById).toHaveBeenCalledWith("cloud-agent-1");
    expect(enqueueAgentMessage).toHaveBeenCalledWith({
      agentId: "cloud-agent-1",
      organizationId: "agent-wallet-org",
      userId: "agent-wallet-user",
      text: "hello",
      senderId: "patron-user",
      sessionId: "session-1",
      roomId: "room-1",
    });
    expect(getJobForOrg).toHaveBeenCalledWith(
      "message-job-1",
      "agent-wallet-org",
    );
    expect(notifyAgentReply).toHaveBeenCalledWith(
      {
        userId: "patron-user",
        agentId: "cloud-agent-1",
        replyText: "hello back",
        title: "New message",
        conversationId: "session-1",
      },
      expect.objectContaining({
        env: expect.objectContaining({
          ELIZA_WEB_PUSH_VAPID_PUBLIC_KEY: "PUBKEY",
          ELIZA_WEB_PUSH_VAPID_PRIVATE_KEY: "PRIVKEY",
        }),
      }),
    );
  });

  test("returns 404 before enqueueing when the agent id is unknown", async () => {
    getAgentById.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/missing-agent/message",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({ text: "hello" }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Agent not found",
    });
    expect(enqueueAgentMessage).not.toHaveBeenCalled();
    expect(getJobForOrg).not.toHaveBeenCalled();
  });

  test("returns retryable 503 on a cold target without enqueueing or dispatching", async () => {
    resolveServiceAgent.mockResolvedValueOnce({ retryable: true });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/message",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({ text: "hello" }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "agent_target_cache_warming",
      retryable: true,
    });
    expect(enqueueAgentMessage).not.toHaveBeenCalled();
    expect(bridgeResolvedShared).not.toHaveBeenCalled();
  });

  test("dispatches a cache-resolved shared target without the daemon job", async () => {
    resolveServiceAgent.mockResolvedValueOnce({
      agent: {
        id: "cloud-agent-1",
        organization_id: "agent-wallet-org",
        user_id: "agent-wallet-user",
        execution_tier: "shared",
        agent_name: "Shared agent",
      },
    });

    const executionCtx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    };
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/message",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({ text: "hello", userId: "patron-user" }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
      executionCtx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      text: "shared reply",
    });
    expect(bridgeResolvedShared).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cloud-agent-1" }),
      expect.objectContaining({
        method: "message.send",
        params: expect.objectContaining({
          text: "hello",
          userId: "patron-user",
        }),
      }),
      executionCtx,
    );
    expect(enqueueAgentMessage).not.toHaveBeenCalled();
  });

  test("surfaces a cold shared authorization cache as retryable without enqueueing", async () => {
    resolveServiceAgent.mockResolvedValueOnce({
      agent: {
        id: "cloud-agent-1",
        organization_id: "agent-wallet-org",
        user_id: "agent-wallet-user",
        execution_tier: "shared",
        agent_name: "Shared agent",
      },
    });
    bridgeResolvedShared.mockResolvedValueOnce({
      jsonrpc: "2.0",
      error: {
        code: -32003,
        message: "Inference authorization cache is warming",
      },
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/message",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({ text: "hello" }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "shared_runtime_cache_warming",
      retryable: true,
    });
    expect(enqueueAgentMessage).not.toHaveBeenCalled();
  });
});
