/**
 * Logout tests cover credential precedence, environment isolation, and the
 * durable-revocation ordering that must succeed before cookies are deleted.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const getCurrentUserMock = mock(async () => null);
const endAllUserSessionsMock = mock(async () => undefined);
const invalidateSessionCachesMock = mock(async (_token: string) => undefined);
const revokeStewardUserSessionsMock = mock(
  async (_accessToken: string, _env: unknown) => undefined,
);
const revokeInferenceStewardSessionMock = mock<
  (
    _token: string,
    _env: unknown,
  ) => Promise<{ userId: string; organizationId: string } | null>
>(async (_token: string, _env: unknown) => ({
  userId: "user-1",
  organizationId: "org-1",
}));

mock.module("@/lib/auth", () => ({
  invalidateSessionCaches: invalidateSessionCachesMock,
}));

mock.module("@/api/auth/steward-refresh-token-revocation", () => ({
  revokeStewardUserSessions: revokeStewardUserSessionsMock,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/user-sessions", () => ({
  userSessionsService: {
    endAllUserSessions: endAllUserSessionsMock,
  },
}));

mock.module("@/lib/services/inference-session-revocation", () => ({
  revokeInferenceStewardSession: revokeInferenceStewardSessionMock,
}));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({
    emit: mock(async () => undefined),
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  getCurrentUserMock.mockClear();
  endAllUserSessionsMock.mockClear();
  invalidateSessionCachesMock.mockClear();
  revokeStewardUserSessionsMock.mockClear();
  revokeInferenceStewardSessionMock.mockClear();
  revokeInferenceStewardSessionMock.mockImplementation(
    async (_token: string, _env: unknown) => ({
      userId: "user-1",
      organizationId: "org-1",
    }),
  );
});

function deletedCookieNames(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((cookie) => /Max-Age=0/i.test(cookie))
    .map((cookie) => cookie.split("=")[0]);
}

describe("POST /api/auth/logout cookie clearing", () => {
  test("staging legacy-only logout does not end production user sessions", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh",
        },
      },
      {
        ENVIRONMENT: "staging",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token-staging");
    expect(cleared).toContain("steward-refresh-token-staging");
    expect(cleared).toContain("steward-authed-staging");
    expect(cleared).not.toContain("steward-token");
    expect(cleared).not.toContain("steward-refresh-token");
    expect(cleared).not.toContain("steward-authed");
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(endAllUserSessionsMock).not.toHaveBeenCalled();
    expect(revokeInferenceStewardSessionMock).not.toHaveBeenCalled();
    expect(invalidateSessionCachesMock).not.toHaveBeenCalled();
  });

  test("staging logout does not delete production's unsuffixed steward cookies", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh; steward-token-staging=staging-token; steward-refresh-token-staging=staging-refresh",
        },
      },
      {
        ENVIRONMENT: "staging",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token-staging");
    expect(cleared).toContain("steward-refresh-token-staging");
    expect(cleared).toContain("steward-authed-staging");
    expect(cleared).not.toContain("steward-token");
    expect(cleared).not.toContain("steward-refresh-token");
    expect(cleared).not.toContain("steward-authed");
    expect(revokeInferenceStewardSessionMock).toHaveBeenCalledTimes(1);
    expect(revokeInferenceStewardSessionMock.mock.calls[0]?.[0]).toBe(
      "staging-token",
    );
    expect(revokeStewardUserSessionsMock).toHaveBeenCalledWith(
      "staging-token",
      expect.anything(),
    );
  });

  test("production logout still clears the historical steward cookies", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api.elizacloud.ai",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token");
    expect(cleared).toContain("steward-refresh-token");
    expect(cleared).toContain("steward-authed");
    expect(revokeInferenceStewardSessionMock).toHaveBeenCalledTimes(1);
    expect(revokeInferenceStewardSessionMock.mock.calls[0]?.[0]).toBe(
      "prod-token",
    );
    expect(revokeStewardUserSessionsMock).toHaveBeenCalledWith(
      "prod-token",
      expect.anything(),
    );
  });

  test("bearer-only Steward logout advances the same revocation boundary as cookie logout", async () => {
    const bearerToken = "bearer.payload.signature";
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          host: "api.elizacloud.ai",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(200);
    expect(revokeInferenceStewardSessionMock).toHaveBeenCalledTimes(1);
    expect(revokeInferenceStewardSessionMock.mock.calls[0]?.[0]).toBe(
      bearerToken,
    );
    expect(revokeStewardUserSessionsMock).toHaveBeenCalledWith(
      bearerToken,
      expect.anything(),
    );
    expect(invalidateSessionCachesMock).toHaveBeenCalledWith(bearerToken);
    expect(getCurrentUserMock).toHaveBeenCalledTimes(1);
  });

  test("revokes distinct JWT bearer and environment-owned cookie credentials", async () => {
    const bearerToken = "bearer.payload.signature";
    const cookieToken = "cookie.payload.signature";
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          cookie: `steward-token=${cookieToken}`,
          host: "api.elizacloud.ai",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(200);
    expect(revokeInferenceStewardSessionMock).toHaveBeenCalledTimes(2);
    expect(
      revokeInferenceStewardSessionMock.mock.calls.map((call) => call[0]),
    ).toEqual([bearerToken, cookieToken]);
    expect(invalidateSessionCachesMock).toHaveBeenCalledWith(bearerToken);
    expect(invalidateSessionCachesMock).toHaveBeenCalledWith(cookieToken);
    expect(revokeStewardUserSessionsMock).toHaveBeenCalledTimes(1);
    expect(revokeStewardUserSessionsMock).toHaveBeenCalledWith(
      cookieToken,
      expect.anything(),
    );
  });

  test("an invalid explicit bearer preserves a valid cookie session", async () => {
    revokeInferenceStewardSessionMock.mockResolvedValueOnce(null);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          authorization: "Bearer invalid.payload.signature",
          cookie:
            "steward-token=cookie.payload.signature; steward-refresh-token=refresh-token",
          host: "api.elizacloud.ai",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(401);
    expect(deletedCookieNames(res)).toEqual([]);
    expect(revokeInferenceStewardSessionMock).toHaveBeenCalledTimes(1);
    expect(revokeStewardUserSessionsMock).not.toHaveBeenCalled();
  });

  test("eliza API-key bearer is never treated as a Steward session", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          authorization: "Bearer eliza_test-api-key",
          cookie: "steward-token=cookie.payload.signature",
          host: "api.elizacloud.ai",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(200);
    expect(revokeInferenceStewardSessionMock).not.toHaveBeenCalled();
    expect(invalidateSessionCachesMock).not.toHaveBeenCalled();
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(deletedCookieNames(res)).toEqual([]);
  });

  test("revocation failure keeps the cookie credential intact for a retry", async () => {
    revokeInferenceStewardSessionMock.mockRejectedValueOnce(
      new Error("Durable Object unavailable"),
    );
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          cookie:
            "steward-token=cookie.payload.signature; eliza-anon-session=anonymous-session",
          host: "api.elizacloud.ai",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(503);
    expect(deletedCookieNames(res)).toEqual([]);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: "Server-side session revocation did not complete; retry logout",
    });
    expect(invalidateSessionCachesMock).not.toHaveBeenCalled();
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  test("session-family revocation failure preserves every browser cookie", async () => {
    revokeStewardUserSessionsMock.mockRejectedValueOnce(
      new Error("Steward unavailable"),
    );
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          cookie:
            "steward-token=cookie.payload.signature; steward-refresh-token=refresh-token",
          host: "api.elizacloud.ai",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(503);
    expect(deletedCookieNames(res)).toEqual([]);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: "Refresh-session revocation did not complete; retry logout",
    });
    expect(invalidateSessionCachesMock).not.toHaveBeenCalled();
  });

  test("a refresh cookie without an authenticated access token is preserved", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          cookie: "steward-refresh-token=refresh-token",
          host: "api.elizacloud.ai",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        STEWARD_JWT_SECRET: "test-secret",
      },
    );

    expect(res.status).toBe(401);
    expect(deletedCookieNames(res)).toEqual([]);
    expect(revokeStewardUserSessionsMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error:
        "Authenticated Steward session required to revoke refresh sessions",
    });
  });
});
