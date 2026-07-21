/**
 * Verifies that Worker-side agent API calls stay on the configured control-plane
 * origin while preserving the public agent identity and protecting its bearer
 * credential. Non-Worker coverage locks the existing direct tailnet route.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { runWithCloudBindings } from "../runtime/cloud-bindings";

// Match the main sandbox suite's module identity; Bun treats query aliases as separate modules.
const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

const sandbox = {
  id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
  environment_vars: { ELIZA_API_TOKEN: "agent-token" },
  bridge_url: "https://legacy-bridge.example",
  health_url: "http://100.64.0.10:23816/api/health",
  node_id: "node-1",
  bridge_port: 18923,
  web_ui_port: 23816,
  headscale_ip: "100.64.0.10",
  sandbox_id: "sandbox-e06bb509",
};

type AgentRecord = typeof sandbox;

type AgentRouterHarness = {
  fetchAgentApi(rec: AgentRecord, path: string, init?: RequestInit): Promise<Response>;
  ensureRuntimeAgentStarted(rec: AgentRecord): Promise<{
    id?: string;
    name?: string;
    status?: string;
  } | null>;
  pushState(
    rec: AgentRecord,
    state: { memories: unknown[]; config: Record<string, unknown>; workspaceFiles: object },
  ): Promise<void>;
};

function service(): AgentRouterHarness {
  return new ElizaSandboxService() as unknown as AgentRouterHarness;
}

function enterWorkerRuntime(): void {
  Object.defineProperty(globalThis, "WebSocketPair", {
    value: class WebSocketPair {},
    configurable: true,
  });
}

function enterNonWorkerRuntime(): void {
  Reflect.deleteProperty(globalThis, "WebSocketPair");
}

function restoreWorkerRuntime(): void {
  if (originalWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
    return;
  }
  Reflect.deleteProperty(globalThis, "WebSocketPair");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWorkerRuntime();
});

describe("ElizaSandboxService Worker agent-router fetch", () => {
  for (const deployment of [
    {
      name: "staging",
      baseDomain: "staging.elizacloud.ai",
      originHost: "eliza-staging-1.elizacloud.ai",
    },
    {
      name: "production",
      baseDomain: "elizacloud.ai",
      originHost: "eliza-production-1.elizacloud.ai",
    },
  ]) {
    test(`keeps ${deployment.name} API traffic on its configured router origin`, async () => {
      enterWorkerRuntime();
      const requests: Array<{ url: string; headers: Headers }> = [];
      globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: typeof input === "string" ? input : input.toString(),
          headers: new Headers(init?.headers),
        });
        return Response.json({ ok: true });
      });

      await runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: deployment.baseDomain,
          AGENT_ROUTER_ORIGIN_HOST: deployment.originHost,
        },
        () => service().fetchAgentApi(sandbox, "/api/agents?limit=20&state=ready"),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        `https://${deployment.originHost}/api/agents?limit=20&state=ready`,
      );
      expect(Object.fromEntries(requests[0]!.headers.entries())).toEqual({
        authorization: "Bearer agent-token",
        "content-type": "application/json",
        "x-api-key": "agent-token",
        "x-eliza-token": "agent-token",
        "x-forwarded-host": `${sandbox.id}.${deployment.baseDomain}`,
        "x-forwarded-proto": "https",
      });
    });
  }

  test("does not let request options replace the trusted agent identity or route", async () => {
    enterWorkerRuntime();
    const requests: Array<{ headers: Headers; redirect: RequestRedirect | undefined }> = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      });
      return Response.json({ ok: true });
    });

    await runWithCloudBindings(
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
      },
      () =>
        service().fetchAgentApi(sandbox, "/api/agents", {
          headers: {
            Authorization: "Bearer attacker-token",
            Host: "attacker.example",
            "X-Api-Key": "attacker-token",
            "X-Eliza-Token": "attacker-token",
            "X-Forwarded-Host": "attacker.example",
            "X-Forwarded-Proto": "http",
          },
          redirect: "follow",
        }),
    );

    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]!.headers.entries())).toEqual({
      authorization: "Bearer agent-token",
      "content-type": "application/json",
      "x-api-key": "agent-token",
      "x-eliza-token": "agent-token",
      "x-forwarded-host": `${sandbox.id}.elizacloud.ai`,
      "x-forwarded-proto": "https",
    });
    expect(requests[0]?.redirect).toBe("manual");
  });

  test("fails closed before fetch when the agent credential is missing", async () => {
    enterWorkerRuntime();
    const fetchMock = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock;

    await expect(
      runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
        },
        () => service().fetchAgentApi({ ...sandbox, environment_vars: {} }, "/api/agents"),
      ),
    ).rejects.toThrow(`Agent proxy requires an API token for ${sandbox.id}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fails closed before fetch when Worker routing configuration is missing or malformed", async () => {
    enterWorkerRuntime();
    const fetchMock = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock;

    for (const bindings of [
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "",
      },
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "http://eliza-production-1.elizacloud.ai",
      },
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "https://eliza-production-1.elizacloud.ai/agent",
      },
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "//eliza-production-1.elizacloud.ai",
      },
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "https://user@example.com",
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
      },
    ]) {
      await expect(
        runWithCloudBindings(bindings, () =>
          service().fetchAgentApi(sandbox, "/api/agents", { method: "GET" }),
        ),
      ).rejects.toThrow(/Worker agent routing requires a valid/);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps the runtime list/start/list lifecycle on one Worker router origin", async () => {
    enterWorkerRuntime();
    const requests: Array<{ url: string; method: string | undefined; headers: Headers }> = [];
    let listCount = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, method: init?.method, headers: new Headers(init?.headers) });
      if (url.endsWith("/api/agents")) {
        listCount += 1;
        return Response.json({
          agents: [
            {
              id: "runtime-agent-1",
              name: "Cloud Agent",
              status: listCount === 1 ? "inactive" : "active",
            },
          ],
        });
      }
      return Response.json({ ok: true });
    });

    const started = await runWithCloudBindings(
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
      },
      () => service().ensureRuntimeAgentStarted(sandbox),
    );

    expect(started).toMatchObject({ id: "runtime-agent-1", status: "active" });
    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: "https://eliza-production-1.elizacloud.ai/api/agents",
        method: "GET",
      },
      {
        url: "https://eliza-production-1.elizacloud.ai/api/agents/runtime-agent-1/start",
        method: "POST",
      },
      {
        url: "https://eliza-production-1.elizacloud.ai/api/agents",
        method: "GET",
      },
    ]);
    for (const request of requests) {
      expect(request.headers.get("x-forwarded-host")).toBe(`${sandbox.id}.elizacloud.ai`);
      expect(request.headers.get("authorization")).toBe("Bearer agent-token");
    }
  });

  test("routes record-based state restore through the same Worker origin", async () => {
    enterWorkerRuntime();
    const requests: Array<{ url: string; headers: Headers; body: BodyInit | null | undefined }> =
      [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input.toString(),
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return Response.json({ ok: true });
    });

    await runWithCloudBindings(
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "staging.elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "eliza-staging-1.elizacloud.ai",
      },
      () =>
        service().pushState(sandbox, {
          memories: [],
          config: { restored: true },
          workspaceFiles: {},
        }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://eliza-staging-1.elizacloud.ai/api/restore");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer agent-token");
    expect(requests[0]?.headers.get("x-forwarded-host")).toBe(
      `${sandbox.id}.staging.elizacloud.ai`,
    );
    expect(requests[0]?.body).toBe(
      '{"memories":[],"config":{"restored":true},"workspaceFiles":{}}',
    );
  });

  test("routes workflow, wallet, and LifeOps proxies through the same Worker origin", async () => {
    enterWorkerRuntime();
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox as never);
    const requests: Array<{
      url: string;
      method: string | undefined;
      headers: Headers;
      body: BodyInit | null | undefined;
    }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return Response.json({ ok: true });
    });

    try {
      await runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "staging.elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-staging-1.elizacloud.ai",
        },
        async () => {
          const sandboxService = new ElizaSandboxService();
          await sandboxService.proxyWorkflowRequest(
            sandbox.id,
            "org-1",
            "workflows",
            "GET",
            null,
            "limit=2&include=output&drop=ignored",
            {
              timeoutMs: 120_000,
              protocolHeaders: {
                Accept: "application/vnd.eliza.workflow+json",
                Authorization: "Bearer cloud-token",
                Cookie: "cloud-session=secret",
                "Idempotency-Key": "workflow-request-1",
                Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                "X-Api-Key": "cloud-api-key",
                "X-Eliza-Organization-Id": "org-spoof",
                "X-Eliza-User-Id": "user-spoof",
                "X-Request-Id": "request-1",
              },
            },
          );
          await sandboxService.proxyWalletRequest(
            sandbox.id,
            "org-1",
            "balances",
            "GET",
            null,
            "limit=1&drop=ignored",
          );
          await sandboxService.proxyLifeOpsScheduleRequest(
            sandbox.id,
            "org-1",
            "observations",
            "POST",
            '{"refresh":true}',
            "timezone=UTC&drop=ignored",
          );
        },
      );
    } finally {
      findRunningSandboxSpy.mockRestore();
    }

    expect(requests.map(({ url }) => url)).toEqual([
      "https://eliza-staging-1.elizacloud.ai/api/workflow/workflows?limit=2&include=output",
      "https://eliza-staging-1.elizacloud.ai/api/wallet/balances?limit=1",
      "https://eliza-staging-1.elizacloud.ai/api/lifeops/schedule/observations?timezone=UTC",
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer agent-token");
      expect(request.headers.get("x-forwarded-host")).toBe(`${sandbox.id}.staging.elizacloud.ai`);
      expect(request.headers.get("x-forwarded-proto")).toBe("https");
    }
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("accept")).toBe("application/vnd.eliza.workflow+json");
    expect(requests[0]?.headers.get("idempotency-key")).toBe("workflow-request-1");
    expect(requests[0]?.headers.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(requests[0]?.headers.get("x-request-id")).toBe("request-1");
    expect(requests[0]?.headers.get("cookie")).toBeNull();
    expect(requests[0]?.headers.get("x-eliza-organization-id")).toBeNull();
    expect(requests[0]?.headers.get("x-eliza-user-id")).toBeNull();
    expect(requests[1]?.method).toBe("GET");
    expect(requests[2]?.method).toBe("POST");
    expect(requests[2]?.headers.get("accept")).toBe("application/json");
    expect(requests[2]?.headers.get("content-type")).toBe("application/json");
    expect(requests[2]?.body).toBe('{"refresh":true}');
  });

  test("accepts every raw plugin-workflow route and rejects paths outside that surface", async () => {
    enterWorkerRuntime();
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox as never);
    const requestedPaths: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requestedPaths.push(new URL(String(input)).pathname);
      return Response.json({ ok: true });
    });
    const routes = [
      ["status", "GET"],
      ["runtime/start", "POST"],
      ["workflows", "GET"],
      ["workflows", "POST"],
      ["workflows/generate", "POST"],
      ["workflows/resolve-clarification", "POST"],
      ["workflows/workflow-1", "GET"],
      ["workflows/workflow-1", "PUT"],
      ["workflows/workflow-1", "DELETE"],
      ["workflows/workflow-1/activate", "POST"],
      ["workflows/workflow-1/deactivate", "POST"],
      ["workflows/workflow-1/run", "POST"],
      ["workflows/workflow-1/executions", "GET"],
      ["executions/execution-1", "GET"],
      ["workflows/workflow-1/revisions", "GET"],
      ["workflows/workflow-1/revisions/version-1/restore", "POST"],
      ["workflows/workflow-1/evaluation-samples", "GET"],
    ] as const;

    try {
      await runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "staging.elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-staging-1.elizacloud.ai",
        },
        async () => {
          const sandboxService = new ElizaSandboxService();
          for (const [path, method] of routes) {
            const response = await sandboxService.proxyWorkflowRequest(
              sandbox.id,
              "org-1",
              path,
              method,
              method === "POST" || method === "PUT" ? "{}" : null,
              "limit=5",
            );
            expect(response?.status).toBe(200);
          }
          const rejected = await sandboxService.proxyWorkflowRequest(
            sandbox.id,
            "org-1",
            "workflows/workflow-1/unknown",
            "GET",
          );
          expect(rejected?.status).toBe(400);
        },
      );
    } finally {
      findRunningSandboxSpy.mockRestore();
    }

    expect(requestedPaths).toEqual(routes.map(([path]) => `/api/workflow/${path}`));
  });

  test("keeps non-Worker API traffic on the existing direct runtime target", async () => {
    enterNonWorkerRuntime();
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input.toString(),
        headers: new Headers(init?.headers),
      });
      return Response.json({ ok: true });
    });

    await runWithCloudBindings(
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "staging.elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "eliza-staging-1.elizacloud.ai",
      },
      () => service().fetchAgentApi(sandbox, "/api/agents?limit=1", { method: "GET" }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://100.64.0.10:23816/api/agents?limit=1");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer agent-token");
    expect(requests[0]?.headers.has("x-forwarded-host")).toBe(false);
    expect(requests[0]?.headers.has("x-forwarded-proto")).toBe(false);
  });
});
