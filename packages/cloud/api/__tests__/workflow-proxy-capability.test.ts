/**
 * Exercises Cloud workflow capability, lifecycle routing, and tenant-boundary
 * behavior. External control-plane services are deterministic boundary fixtures.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as authActual from "@/lib/auth";
import * as billingGateActual from "@/lib/services/agent-billing-gate";
import * as elizaSandboxActual from "@/lib/services/eliza-sandbox";
import * as provisioningJobsActual from "@/lib/services/provisioning-jobs";
import * as workerHealthActual from "@/lib/services/provisioning-worker-health";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const requireAuth = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
}));
type AgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";
type AgentFixture = {
  id: string;
  execution_tier: AgentExecutionTier;
  status?: string;
  bridge_url?: string | null;
  health_url?: string | null;
};
const getAgent = mock<
  (_agentId: string, _organizationId: string) => Promise<AgentFixture | null>
>(async () => ({ id: "agent-1", execution_tier: "shared" }));
const proxyWorkflowRequest = mock<
  (
    agentId: string,
    organizationId: string,
    workflowPath: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: BodyInit | null | undefined,
    query: string | undefined,
    options: {
      principalId: string;
      timeoutMs?: number;
      protocolHeaders?: HeadersInit;
    },
  ) => Promise<Response | null>
>(async () => null);
const checkAgentCreditGate = mock(async (_organizationId: string) => ({
  allowed: true,
}));
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const enqueueAgentWakeOnce = mock(async () => ({
  job: { id: "wake-job-1", status: "pending" },
  created: true,
}));
const triggerImmediate = mock(async (_env: unknown) => undefined);

mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg: requireAuth,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  ...elizaSandboxActual,
  elizaSandboxService: {
    ...elizaSandboxActual.elizaSandboxService,
    getAgent,
    proxyWorkflowRequest,
  },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  ...billingGateActual,
  checkAgentCreditGate,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  ...provisioningJobsActual,
  provisioningJobService: {
    ...provisioningJobsActual.provisioningJobService,
    enqueueAgentWakeOnce,
    triggerImmediate,
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  ...workerHealthActual,
  checkProvisioningWorkerHealth,
}));

const {
  handleWorkflowProxyOptions,
  handleWorkflowProxyRequest,
  workflowContainerPath,
  workflowProxyTimeoutMs,
  workflowRuntimeUnavailableResponse,
} = await import("../v1/eliza/agents/[agentId]/workflows/_shared");
const { default: legacyWorkflowCollectionRoute } = await import(
  "../v1/agents/[agentId]/workflows/route"
);
const { default: legacyWorkflowDetailRoute } = await import(
  "../v1/agents/[agentId]/workflows/[workflowId]/route"
);
const { default: legacyWorkflowRunRoute } = await import(
  "../v1/agents/[agentId]/workflows/[workflowId]/run/route"
);
const { default: legacyWorkflowExecutionRoute } = await import(
  "../v1/agents/[agentId]/workflows/executions/[executionId]/route"
);

const legacyWorkflowApi = new Hono<AppEnv>();
legacyWorkflowApi.route(
  "/api/v1/agents/:agentId/workflows",
  legacyWorkflowCollectionRoute,
);
legacyWorkflowApi.route(
  "/api/v1/agents/:agentId/workflows/:workflowId/run",
  legacyWorkflowRunRoute,
);
legacyWorkflowApi.route(
  "/api/v1/agents/:agentId/workflows/executions/:executionId",
  legacyWorkflowExecutionRoute,
);
legacyWorkflowApi.route(
  "/api/v1/agents/:agentId/workflows/:workflowId",
  legacyWorkflowDetailRoute,
);

const ALLOWLISTED_PROXY_HEADERS = {
  accept: "application/json",
  "accept-encoding": "identity",
  "accept-language": "en-US",
  baggage: "workflow=test",
  "content-encoding": "identity",
  "content-type": "application/json",
  "idempotency-key": "workflow-request-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "eliza=test",
  "x-eliza-trace-id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "x-idempotency-key": "workflow-request-legacy-1",
  "x-request-id": "request-1",
} as const;

const PRIVATE_PROXY_HEADERS = {
  authorization: "Bearer cloud-access-token",
  cookie: "session=cloud-session",
  "proxy-authorization": "Basic cloud-proxy-secret",
  "x-api-key": "cloud-api-key",
  "x-eliza-organization-id": "spoofed-org",
  "x-eliza-user-id": "spoofed-user",
  "x-payment": "cloud-payment-proof",
  "x-private-token": "future-cloud-credential",
  "x-server-token": "spoofed-server-secret",
  "x-wallet-address": "0xcaller",
  "x-wallet-signature": "wallet-signature",
  "x-wallet-timestamp": "1234567890",
} as const;

function credentialRichWorkflowHeaders(): HeadersInit {
  return { ...ALLOWLISTED_PROXY_HEADERS, ...PRIVATE_PROXY_HEADERS };
}

beforeEach(() => {
  requireAuth.mockClear();
  getAgent.mockClear();
  checkAgentCreditGate.mockClear();
  checkProvisioningWorkerHealth.mockClear();
  enqueueAgentWakeOnce.mockClear();
  triggerImmediate.mockClear();
  proxyWorkflowRequest.mockReset();
  proxyWorkflowRequest.mockImplementation(async () => null);
  getAgent.mockImplementation(async () => ({
    id: "agent-1",
    execution_tier: "shared" as const,
  }));
  checkAgentCreditGate.mockImplementation(async () => ({ allowed: true }));
  checkProvisioningWorkerHealth.mockImplementation(async () => ({ ok: true }));
  enqueueAgentWakeOnce.mockImplementation(async () => ({
    job: { id: "wake-job-1", status: "pending" },
    created: true,
  }));
  triggerImmediate.mockImplementation(async () => undefined);
});

afterAll(() => {
  mock.module("@/lib/auth", () => authActual);
  mock.module("@/lib/services/agent-billing-gate", () => billingGateActual);
  mock.module("@/lib/services/eliza-sandbox", () => elizaSandboxActual);
  mock.module("@/lib/services/provisioning-jobs", () => provisioningJobsActual);
  mock.module(
    "@/lib/services/provisioning-worker-health",
    () => workerHealthActual,
  );
});

function context(env: Record<string, unknown> = {}): AppContext {
  return { env } as unknown as AppContext;
}

function workflowRequest(headers?: HeadersInit): Request {
  return new Request(
    "https://api.example.test/api/v1/eliza/agents/agent-1/workflows",
    { headers },
  );
}

async function legacyWorkflowRequest(
  path: string,
  init?: RequestInit,
  env: Record<string, unknown> = {},
): Promise<Response> {
  return await legacyWorkflowApi.request(
    `https://api.example.test${path}`,
    init,
    env,
  );
}

describe("workflow capability responses", () => {
  test("returns an explicit, non-automatic upgrade path for shared agents", async () => {
    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      code: "workflow_requires_dedicated",
      error:
        "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
      capability: "workflows",
      currentExecutionTier: "shared",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
      upgrade: {
        automatic: false,
        method: "POST",
        endpoint: "/api/v1/eliza/agents/agent-1/upgrade-tier",
      },
    });
    expect(proxyWorkflowRequest).not.toHaveBeenCalled();
  });

  test("distinguishes a dedicated runtime outage from an upgrade requirement", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
    }));

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      code: "workflow_runtime_unavailable",
      error: "The agent workflow runtime is temporarily unavailable.",
      capability: "workflows",
      currentExecutionTier: "dedicated-always",
      upgradeRequired: false,
      retryable: true,
    });
  });

  test("credit-gates and enqueues a scale-to-zero agent wake on workflow use", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status: "sleeping",
      bridge_url: null,
      health_url: null,
    }));

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "workflow_runtime_waking",
      currentExecutionTier: "dedicated-lazy",
      retryable: true,
      wake: {
        jobId: "wake-job-1",
        status: "pending",
        created: true,
      },
      polling: { endpoint: "/api/v1/jobs/wake-job-1", intervalMs: 5000 },
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(enqueueAgentWakeOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("ignores a stale live assignment when a dedicated-lazy agent is stopped", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status: "stopped",
      bridge_url: "https://stale-bridge.example.test",
      health_url: "https://stale-health.example.test",
    }));
    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "workflow_runtime_waking",
      currentExecutionTier: "dedicated-lazy",
      wake: { jobId: "wake-job-1" },
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(enqueueAgentWakeOnce).toHaveBeenCalledTimes(1);
    expect(proxyWorkflowRequest).not.toHaveBeenCalled();
  });

  test("does not let a stale sleeping assignment bypass the credit gate", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status: "sleeping",
      bridge_url: null,
      health_url: null,
    }));
    checkAgentCreditGate.mockImplementation(async () => ({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    }));
    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "insufficient_credits",
      currentBalance: 0,
    });
    expect(enqueueAgentWakeOnce).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
    expect(proxyWorkflowRequest).not.toHaveBeenCalled();
  });

  test.each([
    "error",
    "provisioning",
    "pending",
    "deletion_pending",
    "deletion_failed",
  ])("does not wake a dedicated-lazy runtime in %s state", async (status) => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status,
      bridge_url: null,
      health_url: null,
    }));

    const response = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "workflow_runtime_unavailable",
      currentExecutionTier: "dedicated-lazy",
    });
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(enqueueAgentWakeOnce).not.toHaveBeenCalled();
  });

  test("encodes agent IDs in the upgrade endpoint", async () => {
    const response = workflowRuntimeUnavailableResponse("agent/id", "shared");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      upgrade: {
        endpoint: "/api/v1/eliza/agents/agent%2Fid/upgrade-tier",
      },
    });
  });
});

describe("workflow proxy timeout budgets", () => {
  test("allows synchronous Smithers runs to reach their engine deadline", () => {
    expect(workflowProxyTimeoutMs("POST", "workflow-1/run")).toBe(10 * 60_000);
  });

  test("gives generation and clarification more room than ordinary API calls", () => {
    expect(workflowProxyTimeoutMs("POST", "generate")).toBe(5 * 60_000);
    expect(workflowProxyTimeoutMs("POST", "resolve-clarification")).toBe(
      5 * 60_000,
    );
    expect(workflowProxyTimeoutMs("POST", "workflow-1/activate")).toBe(120_000);
    expect(workflowProxyTimeoutMs("GET", "workflow-1/run")).toBe(120_000);
  });

  test("translates an upstream deadline into a retryable 504", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
      status: "running",
    }));
    proxyWorkflowRequest.mockImplementation(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });

    const response = await handleWorkflowProxyRequest(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/workflows/workflow-1/run",
        {
          method: "POST",
          headers: { origin: "https://localhost" },
        },
      ),
      "agent-1",
      "workflow-1/run",
      context(),
    );

    expect(response.status).toBe(504);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      code: "agent_timeout",
      error:
        "Agent did not start responding in time. The workflow may still be processing; retry shortly.",
      retryable: true,
    });
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://localhost",
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  test("reflects a trusted app origin on workflow preflight", () => {
    const response = handleWorkflowProxyOptions("https://localhost");

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://localhost",
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });
});

describe("legacy Cloud SDK workflow routes", () => {
  test.each([
    ["GET", "/api/v1/agents/agent-1/workflows"],
    ["POST", "/api/v1/agents/agent-1/workflows"],
    ["GET", "/api/v1/agents/agent-1/workflows/workflow-1"],
    ["PUT", "/api/v1/agents/agent-1/workflows/workflow-1"],
    ["DELETE", "/api/v1/agents/agent-1/workflows/workflow-1"],
    ["POST", "/api/v1/agents/agent-1/workflows/workflow-1/run"],
    ["GET", "/api/v1/agents/agent-1/workflows/executions/execution-1"],
  ])("%s %s uses the canonical shared-tier capability response", async (method, path) => {
    const response = await legacyWorkflowRequest(path, { method });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "workflow_requires_dedicated",
      capability: "workflows",
      upgradeRequired: true,
    });
    expect(proxyWorkflowRequest).not.toHaveBeenCalled();
  });

  test("preserves trusted app-origin CORS on legacy preflight and responses", async () => {
    const origin = "https://localhost";
    const preflight = await legacyWorkflowRequest(
      "/api/v1/agents/agent-1/workflows",
      { method: "OPTIONS", headers: { origin } },
    );
    const response = await legacyWorkflowRequest(
      "/api/v1/agents/agent-1/workflows",
      { headers: { origin } },
    );

    for (const result of [preflight, response]) {
      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(result.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
      expect(result.headers.get("Vary")).toBe("Origin");
    }
    expect(preflight.status).toBe(204);
    expect(response.status).toBe(409);
  });

  test("keeps legacy requests inside the authenticated organization", async () => {
    getAgent.mockImplementation(async () => null);

    const response = await legacyWorkflowRequest(
      "/api/v1/agents/foreign-agent/workflows",
      { headers: { origin: "https://localhost" } },
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      error: "Agent not found",
    });
    expect(getAgent).toHaveBeenCalledWith("foreign-agent", "org-1");
    expect(proxyWorkflowRequest).not.toHaveBeenCalled();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://localhost",
    );
  });

  test("rejects invalid workflow path segments before runtime lookup", async () => {
    const response = await legacyWorkflowRequest(
      "/api/v1/agents/agent-1/workflows/workflow.with.dots",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      code: "invalid_workflow_path",
      error: "Invalid agent or workflow path.",
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(proxyWorkflowRequest).not.toHaveBeenCalled();
  });

  test("credit-gates sleeping runtimes before a legacy SDK request can wake them", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-lazy" as const,
      status: "sleeping",
      bridge_url: null,
      health_url: null,
    }));
    checkAgentCreditGate.mockImplementation(async () => ({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    }));

    const response = await legacyWorkflowRequest(
      "/api/v1/agents/agent-1/workflows",
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "insufficient_credits",
      currentBalance: 0,
    });
    expect(enqueueAgentWakeOnce).not.toHaveBeenCalled();
  });

  test("forwards a run to the canonical container with the long-run deadline", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
      status: "running",
    }));
    proxyWorkflowRequest.mockImplementation(async () =>
      Response.json({ execution: { id: "execution-1" } }),
    );

    const response = await legacyWorkflowRequest(
      "/api/v1/agents/agent-1/workflows/workflow-1/run",
      {
        method: "POST",
        headers: credentialRichWorkflowHeaders(),
        body: JSON.stringify({ triggerData: { source: "sdk" } }),
      },
    );

    expect(response.status).toBe(200);
    const call = proxyWorkflowRequest.mock.calls[0];
    expect(call?.slice(0, 4)).toEqual([
      "agent-1",
      "org-1",
      "workflows/workflow-1/run",
      "POST",
    ]);
    expect(
      JSON.parse(new TextDecoder().decode(call?.[4] as ArrayBuffer)),
    ).toEqual({
      triggerData: { source: "sdk" },
    });
    expect(call?.[5]).toBe("");
    expect(call?.[6]?.timeoutMs).toBe(10 * 60_000);
    expect(call?.[6]).toMatchObject({
      principalId: "user-1",
    });
  });

  test("returns the canonical retryable timeout contract for a legacy run", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
      status: "running",
    }));
    proxyWorkflowRequest.mockImplementation(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });

    const response = await legacyWorkflowRequest(
      "/api/v1/agents/agent-1/workflows/workflow-1/run",
      {
        method: "POST",
        headers: { origin: "https://localhost" },
      },
    );

    expect(response.status).toBe(504);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://localhost",
    );
    expect(await response.json()).toMatchObject({
      success: false,
      code: "agent_timeout",
      retryable: true,
    });
  });

  test("maps legacy execution lookup to the container execution route", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
      status: "running",
    }));
    proxyWorkflowRequest.mockImplementation(async () =>
      Response.json({ execution: { id: "execution-1" } }),
    );

    const response = await legacyWorkflowRequest(
      "/api/v1/agents/agent-1/workflows/executions/execution-1?include=output",
    );

    expect(response.status).toBe(200);
    expect(proxyWorkflowRequest.mock.calls[0]?.slice(0, 6)).toEqual([
      "agent-1",
      "org-1",
      "executions/execution-1",
      "GET",
      undefined,
      "include=output",
    ]);
  });
});

describe("workflow dedicated-container routing", () => {
  test.each([
    ["", "workflows"],
    ["status", "status"],
    ["runtime/start", "runtime/start"],
    ["generate", "workflows/generate"],
    ["resolve-clarification", "workflows/resolve-clarification"],
    ["workflow-1", "workflows/workflow-1"],
    ["workflow-1/activate", "workflows/workflow-1/activate"],
    ["workflow-1/deactivate", "workflows/workflow-1/deactivate"],
    ["workflow-1/run", "workflows/workflow-1/run"],
    ["workflow-1/executions", "workflows/workflow-1/executions"],
    [
      "workflow-1/evaluation-samples",
      "workflows/workflow-1/evaluation-samples",
    ],
    ["workflow-1/revisions", "workflows/workflow-1/revisions"],
    [
      "workflow-1/revisions/version-1/restore",
      "workflows/workflow-1/revisions/version-1/restore",
    ],
    ["executions/execution-1", "executions/execution-1"],
  ])("maps Cloud suffix %s to plugin route %s", (suffix, expected) => {
    expect(workflowContainerPath(suffix)).toBe(expected);
  });

  test("passes request bytes and protocol metadata to the sandbox boundary", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
    }));
    proxyWorkflowRequest.mockImplementation(async () =>
      Response.json({ ok: true }),
    );

    const response = await handleWorkflowProxyRequest(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/workflows/resolve-clarification",
        {
          method: "POST",
          headers: credentialRichWorkflowHeaders(),
          body: JSON.stringify({ draft: {}, resolutions: [] }),
        },
      ),
      "agent-1",
      "resolve-clarification",
      context(),
    );

    expect(response.status).toBe(200);
    const call = proxyWorkflowRequest.mock.calls[0];
    expect(call?.slice(0, 4)).toEqual([
      "agent-1",
      "org-1",
      "workflows/resolve-clarification",
      "POST",
    ]);
    expect(
      JSON.parse(new TextDecoder().decode(call?.[4] as ArrayBuffer)),
    ).toEqual({
      draft: {},
      resolutions: [],
    });
    expect(call?.[6]?.timeoutMs).toBe(5 * 60_000);
    expect(call?.[6]).toMatchObject({
      principalId: "user-1",
    });
    expect(new Headers(call?.[6]?.protocolHeaders).get("x-eliza-user-id")).toBe(
      "spoofed-user",
    );
  });

  test("keeps same-organization users in distinct workflow principal scopes", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
      status: "running",
    }));
    proxyWorkflowRequest.mockImplementation(async () =>
      Response.json({ workflows: [] }),
    );

    for (const userId of ["user-a", "user-b"]) {
      requireAuth.mockImplementationOnce(async () => ({
        user: { id: userId, organization_id: "org-1" },
      }));
      const response = await handleWorkflowProxyRequest(
        workflowRequest({ "x-eliza-user-id": "spoofed-user" }),
        "agent-1",
        "",
        context(),
      );
      expect(response.status).toBe(200);
      expect(proxyWorkflowRequest.mock.calls.at(-1)?.[6]).toMatchObject({
        principalId: userId,
      });
    }
  });

  test("forwards the evaluation-samples suffix and query without a body", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
    }));
    proxyWorkflowRequest.mockImplementation(async () =>
      Response.json({ workflowId: "workflow-1" }),
    );

    const response = await handleWorkflowProxyRequest(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/workflows/workflow-1/evaluation-samples?limit=7",
      ),
      "agent-1",
      "workflow-1/evaluation-samples",
      context(),
    );

    expect(response.status).toBe(200);
    expect(proxyWorkflowRequest.mock.calls[0]?.slice(0, 6)).toEqual([
      "agent-1",
      "org-1",
      "workflows/workflow-1/evaluation-samples",
      "GET",
      undefined,
      "limit=7",
    ]);
  });

  test("lists and runs a chat-created workflow through the Cloud boundary", async () => {
    getAgent.mockImplementation(async () => ({
      id: "agent-1",
      execution_tier: "dedicated-always" as const,
      status: "running",
    }));
    const chatCreatedWorkflow = {
      id: "chat-workflow-1",
      name: "Created in chat",
      active: false,
    };
    proxyWorkflowRequest.mockImplementation(
      async (_agentId, _organizationId, workflowPath, method) => {
        if (workflowPath === "workflows" && method === "GET") {
          return Response.json({ workflows: [chatCreatedWorkflow] });
        }
        if (
          workflowPath === "workflows/chat-workflow-1/run" &&
          method === "POST"
        ) {
          return Response.json({
            execution: {
              id: "execution-1",
              workflowId: chatCreatedWorkflow.id,
              status: "success",
            },
          });
        }
        return Response.json({ error: "unexpected route" }, { status: 404 });
      },
    );

    const listed = await handleWorkflowProxyRequest(
      workflowRequest(),
      "agent-1",
      "",
      context(),
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()) as Record<string, unknown>).toEqual({
      workflows: [chatCreatedWorkflow],
    });

    const ran = await handleWorkflowProxyRequest(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/workflows/chat-workflow-1/run",
        { method: "POST" },
      ),
      "agent-1",
      "chat-workflow-1/run",
      context(),
    );
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({
      execution: { workflowId: "chat-workflow-1", status: "success" },
    });
    expect(
      proxyWorkflowRequest.mock.calls.map((call) => call.slice(0, 4)),
    ).toEqual([
      ["agent-1", "org-1", "workflows", "GET"],
      ["agent-1", "org-1", "workflows/chat-workflow-1/run", "POST"],
    ]);
  });
});
