/**
 * Tests for GET /api/v1/hf-proxy/[...path].
 *
 * The route is the authenticated server-side HuggingFace download proxy used by
 * cloud-linked devices: it requires a valid linked account, only forwards
 * genuine `/resolve/` download paths, refuses to run without the cloud-side
 * `HF_TOKEN`, and otherwise streams the upstream HuggingFace response straight
 * through with the cloud token attached.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";
// Spread the real module: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports of workers-hono-auth would
// break every later test file that imports from it.
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as loggerActual from "@/lib/utils/logger";

const requireUserOrApiKeyWithOrg =
  mock<(c: unknown) => Promise<{ id: string; organization_id: string }>>();
const loggerInfo = mock(() => undefined);
const loggerWarn = mock(() => undefined);
const loggerError = mock(() => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: () => undefined,
  },
}));

// The route reads `c.req.param("*")`, which is only populated when the app is
// mounted under the named-splat path the codegen emits in `_router.generated`.
// Mount it the same way so the test exercises the real path resolution.
const HF_PROXY_MOUNT = "/api/v1/hf-proxy/:*{.+}";

let app: Hono;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  const { default: hfProxyRoute } = (await import(
    "../v1/hf-proxy/[...path]/route"
  )) as { default: Parameters<Hono["route"]>[1] };
  app = new Hono().route(HF_PROXY_MOUNT, hfProxyRoute);
});

beforeEach(() => {
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
});

afterEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const RESOLVE_PATH = "elizaos/eliza-1/resolve/main/model.gguf";

function fakeKv() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async () => ({
      keys: [...map.keys()].map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function makeRequest(
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://api.example.test/api/v1/hf-proxy/${path}`, {
    method: "GET",
    headers,
  });
}

describe("GET /api/v1/hf-proxy/[...path]", () => {
  test("requires authentication", async () => {
    // An unauthenticated request throws from the auth gate before any proxying.
    requireUserOrApiKeyWithOrg.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), {
        name: "AuthenticationError",
      }),
    );

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(401);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("rejects a non-/resolve/ path with 400", async () => {
    const res = await app.fetch(makeRequest("elizaos/eliza-1/tree/main"), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Only HuggingFace resolve paths are proxied.");
  });

  test("returns 503 when HF_TOKEN is not configured", async () => {
    const res = await app.fetch(makeRequest(RESOLVE_PATH), {});

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "HuggingFace proxy is not configured on this deployment.",
    );
  });

  test("proxies a valid /resolve/ request through to HuggingFace with the cloud token", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | null | undefined;
    let capturedRange: string | null | undefined;

    globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      capturedRange = headers.get("range");
      return new Response("GGUF-BYTES", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "10",
          "accept-ranges": "bytes",
        },
      });
    }) as unknown as typeof fetch;

    const res = await app.fetch(
      makeRequest(`${RESOLVE_PATH}?download=true`, { range: "bytes=0-9" }),
      { HF_TOKEN: "hf-secret" },
    );

    expect(res.status).toBe(200);
    // Reconstructs the upstream HuggingFace URL 1:1, preserving the query.
    expect(capturedUrl).toBe(
      `https://huggingface.co/${RESOLVE_PATH}?download=true`,
    );
    // Attaches the cloud-side HF token, never a client-supplied one.
    expect(capturedAuth).toBe("Bearer hf-secret");
    // Forwards Range so resumable downloads work.
    expect(capturedRange).toBe("bytes=0-9");

    // Streams the upstream body and preserves download-relevant headers.
    expect(await res.text()).toBe("GGUF-BYTES");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(loggerInfo).toHaveBeenCalledWith(
      "[hf-proxy] egress metric",
      expect.objectContaining({
        organizationId: "org-1",
        repo: "elizaos/eliza-1",
        bytes: 10,
        status: 200,
      }),
    );
  });

  test("returns structured HF_GATED for upstream 401/403", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("private", {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "HuggingFace repo is gated or unauthorized.",
      code: "HF_GATED",
      repo: "elizaos/eliza-1",
    });
  });

  test("enforces per-org monthly egress budget before streaming the next response", async () => {
    const kv = fakeKv();
    globalThis.fetch = mock(
      async () =>
        new Response("12345678", {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "8",
          },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };
    const first = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("12345678");

    const second = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      code?: string;
      limit_bytes?: number;
      used_bytes?: number;
    };
    expect(body.code).toBe("HF_PROXY_EGRESS_LIMIT");
    expect(body.limit_bytes).toBe(12);
    expect(body.used_bytes).toBe(8);
  });
});
