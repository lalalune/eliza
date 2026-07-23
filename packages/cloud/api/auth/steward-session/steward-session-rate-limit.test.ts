/**
 * Exercises the real Steward-session route with a failed Redis limiter.
 * External identity and revocation services are isolated while route-owned
 * fallback limiting and durable logout ordering remain under test.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const emitAudit = mock(async () => undefined);
const verifyStewardTokenCached = mock(async (_env: unknown, token: string) =>
  token === "valid-steward-token"
    ? {
        userId: "steward-user-1",
        email: "person@example.test",
        expiration: Math.floor(Date.now() / 1000) + 900,
      }
    : null,
);
const syncUserFromSteward = mock(async () => ({
  id: "cloud-user-1",
  organization_id: "org-1",
  initialCreditsGranted: false,
  initialFreeCreditsUsd: "0.00",
  welcomeBonusWithheld: false,
  welcomeBonusWithheldReason: undefined,
  welcomeBonusWithheldMessage: undefined,
}));
const invalidateSessionCaches = mock(async (_token: string) => undefined);
const revokeStewardRefreshToken = mock(
  async (_refreshToken: string, _env: unknown) => undefined,
);
const revokeInferenceStewardSession = mock(
  async (_token: string, _env: unknown) => ({
    userId: "cloud-user-1",
    organizationId: "org-1",
  }),
);

const throwingRedis = {
  incr: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pttl: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pexpire: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
};

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => throwingRedis,
  hasRedisConfig: () => true,
  isCloudflareWorkerRuntime: () => false,
}));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitAudit }),
}));

mock.module("@/lib/auth", () => ({
  invalidateSessionCaches,
}));

mock.module("@/api/auth/steward-refresh-token-revocation", () => ({
  revokeStewardRefreshToken,
}));

mock.module("@/lib/auth/steward-client", () => ({
  verifyStewardTokenCached,
}));

mock.module("@/lib/services/inference-session-revocation", () => ({
  revokeInferenceStewardSession,
}));

mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  syncUserFromSteward,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: stewardSessionRoute } = await import("./route");
const { _resetRedisUnavailableFallbackBuckets } = await import(
  "@/lib/middleware/rate-limit-hono-cloudflare"
);

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  REDIS_URL: "redis://mock:6379",
  STEWARD_SESSION_SECRET: "test-secret",
};

function postStewardSession(body: unknown, ip = "203.0.113.10") {
  const app = new Hono();
  app.route("/api/auth/steward-session", stewardSessionRoute);
  return app.fetch(
    new Request("https://api-staging.elizacloud.ai/api/auth/steward-session", {
      method: "POST",
      headers: {
        "cf-connecting-ip": ip,
        "content-type": "application/json",
        origin: "https://staging.elizacloud.ai",
      },
      body: JSON.stringify(body),
    }),
    ENV,
  );
}

function deleteStewardSession(cookie: string, ip = "203.0.113.11") {
  const app = new Hono();
  app.route("/api/auth/steward-session", stewardSessionRoute);
  return app.fetch(
    new Request("https://api-staging.elizacloud.ai/api/auth/steward-session", {
      method: "DELETE",
      headers: {
        "cf-connecting-ip": ip,
        cookie,
        origin: "https://staging.elizacloud.ai",
      },
    }),
    ENV,
  );
}

function deletedCookieNames(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((cookie) => /Max-Age=0/i.test(cookie))
    .map((cookie) => cookie.split("=")[0]);
}

beforeEach(() => {
  emitAudit.mockClear();
  verifyStewardTokenCached.mockClear();
  syncUserFromSteward.mockClear();
  invalidateSessionCaches.mockClear();
  revokeStewardRefreshToken.mockClear();
  revokeInferenceStewardSession.mockClear();
  revokeInferenceStewardSession.mockImplementation(
    async (_token: string, _env: unknown) => ({
      userId: "cloud-user-1",
      organizationId: "org-1",
    }),
  );
  _resetRedisUnavailableFallbackBuckets();
});

describe("POST /api/auth/steward-session — Redis outage fallback limiter", () => {
  test("a missing token reaches normal auth validation instead of rate_limit_unavailable", async () => {
    const res = await postStewardSession({});
    expect(res.status).toBe(400);
    expect(res.headers.get("X-RateLimit-Policy")).toBe(
      "redis-unavailable-local",
    );
    await expect(res.json()).resolves.toMatchObject({
      code: "missing_token",
    });
    expect(verifyStewardTokenCached).not.toHaveBeenCalled();
  });

  test("a valid Steward token can mint staging-scoped cookies while Redis is down", async () => {
    const res = await postStewardSession({
      token: "valid-steward-token",
      refreshToken: "valid-refresh-token",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Policy")).toBe(
      "redis-unavailable-local",
    );
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      userId: "cloud-user-1",
      stewardUserId: "steward-user-1",
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("steward-token-staging=valid-steward-token");
    expect(setCookie).toContain(
      "steward-refresh-token-staging=valid-refresh-token",
    );
    expect(verifyStewardTokenCached).toHaveBeenCalledTimes(1);
    expect(syncUserFromSteward).toHaveBeenCalledTimes(1);
  });

  test("invalid-token spray is still bounded by the local fallback bucket", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await postStewardSession({ token: `invalid-${i}` });
      expect(res.status).toBe(401);
    }

    const blocked = await postStewardSession({ token: "invalid-10" });
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      success: false,
      code: "rate_limit_exceeded",
    });
    expect(blocked.headers.get("X-RateLimit-Policy")).toBe(
      "redis-unavailable-local",
    );
    expect(verifyStewardTokenCached).toHaveBeenCalledTimes(10);
  });
});

describe("DELETE /api/auth/steward-session — durable revocation ordering", () => {
  test("revokes an environment-owned session before deleting its cookies", async () => {
    const res = await deleteStewardSession(
      "steward-token-staging=cookie.payload.signature",
    );

    expect(res.status).toBe(200);
    expect(revokeInferenceStewardSession).toHaveBeenCalledTimes(1);
    expect(revokeInferenceStewardSession.mock.calls[0]?.[0]).toBe(
      "cookie.payload.signature",
    );
    expect(invalidateSessionCaches).toHaveBeenCalledWith(
      "cookie.payload.signature",
    );
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token-staging");
    expect(cleared).toContain("steward-refresh-token-staging");
    expect(cleared).toContain("steward-authed-staging");
    expect(cleared).not.toContain("steward-token");
  });

  test("revocation failure returns 503 without deleting the retry credential", async () => {
    revokeInferenceStewardSession.mockRejectedValueOnce(
      new Error("Durable Object unavailable"),
    );
    const res = await deleteStewardSession(
      "steward-token-staging=cookie.payload.signature",
    );

    expect(res.status).toBe(503);
    expect(deletedCookieNames(res)).toEqual([]);
    await expect(res.json()).resolves.toEqual({
      error: "Server-side session revocation did not complete; retry logout",
    });
    expect(invalidateSessionCaches).not.toHaveBeenCalled();
  });

  test("revokes the environment-owned refresh token before deleting cookies", async () => {
    const res = await deleteStewardSession(
      "steward-token-staging=cookie.payload.signature; steward-refresh-token-staging=refresh-token",
    );

    expect(res.status).toBe(200);
    expect(revokeStewardRefreshToken).toHaveBeenCalledWith(
      "refresh-token",
      expect.anything(),
    );
    expect(deletedCookieNames(res)).toContain(
      "steward-refresh-token-staging",
    );
  });

  test("refresh revocation failure preserves the access and refresh cookies", async () => {
    revokeStewardRefreshToken.mockRejectedValueOnce(
      new Error("Steward unavailable"),
    );
    const res = await deleteStewardSession(
      "steward-token-staging=cookie.payload.signature; steward-refresh-token-staging=refresh-token",
    );

    expect(res.status).toBe(503);
    expect(deletedCookieNames(res)).toEqual([]);
    await expect(res.json()).resolves.toEqual({
      error: "Refresh-session revocation did not complete; retry logout",
    });
    expect(invalidateSessionCaches).not.toHaveBeenCalled();
  });
});
