// Exercises cloud API auth steward refresh route.test behavior with deterministic Worker route fixtures.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type VerifiedStewardClaims = {
  userId: string;
  email: string;
  tenantId: string;
  expiration: number;
  issuedAt: number;
};

const verifyStewardTokenCached = mock<
  (_env: unknown, _token: string) => Promise<VerifiedStewardClaims | null>
>(async () => ({
  userId: "steward-user-1",
  email: "user@example.com",
  tenantId: "elizacloud",
  expiration: Math.floor(Date.now() / 1000) + 60,
  issuedAt: Math.floor(Date.now() / 1000) - 60,
}));

const mintStewardTokenFromClaims = mock<
  (
    _env: unknown,
    _claims: VerifiedStewardClaims,
    _ttlSeconds: number,
    _options: { minimumIssuedAt?: number },
  ) => Promise<{ token: string; expiresAt: number; expiresIn: number } | null>
>(async () => ({
  token: "fresh-steward-jwt",
  expiresAt: 1_800_000_000,
  expiresIn: 3600,
}));
const getByStewardIdForWrite = mock(async (_stewardUserId: string) => ({
  id: "cloud-user-1",
  steward_user_id: "steward-user-1",
  organization_id: "org-1",
  is_active: true,
  inference_session_not_before: 0,
  organization: {
    id: "org-1",
    is_active: true,
  },
}));

mock.module("@/lib/auth/steward-client", () => ({
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS: 25_000,
  verifyStewardTokenCached,
  mintStewardTokenFromClaims,
}));

mock.module("@/lib/steward/sign", () => ({
  signStewardMutatingRequest: mock(async () => undefined),
}));

mock.module("@/lib/services/users", () => ({
  usersService: { getByStewardIdForWrite },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

const ENV = {
  NODE_ENV: "production",
  STEWARD_JWT_SECRET: "secret",
  STEWARD_TENANT_ID: "elizacloud",
};
const originalFetch = globalThis.fetch;

function post(headers: HeadersInit = {}) {
  return app.fetch(
    new Request("https://api.elizacloud.ai/", {
      method: "POST",
      headers,
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

function refreshedUser(inferenceSessionNotBefore = 0) {
  return {
    id: "cloud-user-1",
    steward_user_id: "steward-user-1",
    organization_id: "org-1",
    is_active: true,
    inference_session_not_before: inferenceSessionNotBefore,
    organization: {
      id: "org-1",
      is_active: true,
    },
  };
}

function postCookieRefresh() {
  return app.fetch(
    new Request("https://api.elizacloud.ai/", {
      method: "POST",
      headers: {
        host: "api.elizacloud.ai",
        origin: "https://elizacloud.ai",
        cookie: "steward-refresh-token=current-refresh-token",
      },
    }),
    {
      ...ENV,
      ENVIRONMENT: "production",
      STEWARD_API_URL: "https://steward.example.test",
    },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("steward-refresh bearer rotation", () => {
  beforeEach(() => {
    verifyStewardTokenCached.mockClear();
    mintStewardTokenFromClaims.mockClear();
    getByStewardIdForWrite.mockClear();
    verifyStewardTokenCached.mockResolvedValue({
      userId: "steward-user-1",
      email: "user@example.com",
      tenantId: "elizacloud",
      expiration: Math.floor(Date.now() / 1000) + 60,
      issuedAt: Math.floor(Date.now() / 1000) - 60,
    });
    mintStewardTokenFromClaims.mockResolvedValue({
      token: "fresh-steward-jwt",
      expiresAt: 1_800_000_000,
      expiresIn: 3600,
    });
    getByStewardIdForWrite.mockResolvedValue({
      id: "cloud-user-1",
      steward_user_id: "steward-user-1",
      organization_id: "org-1",
      is_active: true,
      inference_session_not_before: 0,
      organization: {
        id: "org-1",
        is_active: true,
      },
    });
  });

  test("accepts native Bearer refresh without browser Origin or refresh cookie", async () => {
    const response = await post({
      Authorization: "Bearer near-expiry-steward-jwt",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      token: "fresh-steward-jwt",
      expiresAt: 1_800_000_000,
      expiresIn: 3600,
    });
    expect(verifyStewardTokenCached).toHaveBeenCalledWith(
      expect.objectContaining({ STEWARD_JWT_SECRET: "secret" }),
      "near-expiry-steward-jwt",
    );
    expect(mintStewardTokenFromClaims).toHaveBeenCalledWith(
      expect.objectContaining({ STEWARD_JWT_SECRET: "secret" }),
      expect.objectContaining({ userId: "steward-user-1" }),
      3600,
      { minimumIssuedAt: 0 },
    );
  });

  test("rejects invalid Bearer refresh before falling back to cookie refresh", async () => {
    verifyStewardTokenCached.mockResolvedValue(null);

    const response = await post({
      Authorization: "Bearer expired-steward-jwt",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid token",
      code: "invalid_token",
    });
    expect(mintStewardTokenFromClaims).not.toHaveBeenCalled();
  });

  test("rejects a bearer issued before the durable logout epoch", async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    verifyStewardTokenCached.mockResolvedValue({
      userId: "steward-user-1",
      email: "user@example.com",
      tenantId: "elizacloud",
      expiration: Math.floor(Date.now() / 1000) + 60,
      issuedAt,
    });
    getByStewardIdForWrite.mockResolvedValue({
      id: "cloud-user-1",
      steward_user_id: "steward-user-1",
      organization_id: "org-1",
      is_active: true,
      inference_session_not_before: issuedAt + 1,
      organization: {
        id: "org-1",
        is_active: true,
      },
    });

    const response = await post({
      Authorization: "Bearer logged-out-steward-jwt",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid token",
      code: "invalid_token",
    });
    expect(mintStewardTokenFromClaims).not.toHaveBeenCalled();
  });

  test("fails closed when authoritative bearer authorization is unavailable", async () => {
    getByStewardIdForWrite.mockRejectedValueOnce(
      new Error("primary unavailable"),
    );

    const response = await post({
      Authorization: "Bearer near-expiry-steward-jwt",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Session authorization unavailable",
      code: "internal_error",
    });
    expect(mintStewardTokenFromClaims).not.toHaveBeenCalled();
  });

  test("keeps the browser cookie path origin-gated when no Bearer token is supplied", async () => {
    const response = await post();

    expect(response.status).toBe(403);
    expect(verifyStewardTokenCached).not.toHaveBeenCalled();
    expect(mintStewardTokenFromClaims).not.toHaveBeenCalled();
  });
});

describe("steward-refresh browser cookie cleanup", () => {
  test("staging legacy-only refresh cookie is not read or forwarded", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("legacy refresh cookie must not reach Steward");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const response = await app.fetch(
        new Request("https://api-staging.elizacloud.ai/", {
          method: "POST",
          headers: {
            host: "api-staging.elizacloud.ai",
            origin: "https://staging.elizacloud.ai",
            cookie: "steward-refresh-token=prod-refresh; steward-authed=1",
          },
        }),
        {
          ...ENV,
          ENVIRONMENT: "staging",
          STEWARD_API_URL: "https://steward.example.test",
        },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Refresh token required",
        code: "missing_token",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deletedCookieNames(response)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("invalid refresh clears NO cookies (rotation-race safety, #13728 env-scoping holds trivially)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "refresh rejected" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const response = await app.fetch(
        new Request("https://api-staging.elizacloud.ai/", {
          method: "POST",
          headers: {
            host: "api-staging.elizacloud.ai",
            origin: "https://staging.elizacloud.ai",
            cookie:
              "steward-refresh-token=prod-refresh; steward-authed=1; steward-refresh-token-staging=staging-refresh; steward-authed-staging=1",
          },
        }),
        {
          ...ENV,
          ENVIRONMENT: "staging",
          STEWARD_API_URL: "https://steward.example.test",
        },
      );

      expect(response.status).toBe(401);
      // A Steward 401 also fires for the LOSER of a refresh-rotation race
      // (single-use tokens, one domain-wide cookie shared by console + app
      // tabs). Clearing cookies here nuked the whole session on every lost
      // race — the winner's fresh cookies included. The route now clears
      // NOTHING on 401: the race self-heals from the winner's Set-Cookie,
      // and a genuinely dead token keeps 401ing into the login surface.
      // The #13728 env-scoping invariant (staging must never clear prod
      // cookies) holds trivially.
      const cleared = deletedCookieNames(response);
      expect(cleared).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("steward-refresh browser authorization race", () => {
  const issuedAt = 1_800_000_000;

  beforeEach(() => {
    verifyStewardTokenCached.mockClear();
    getByStewardIdForWrite.mockClear();
    verifyStewardTokenCached.mockResolvedValue({
      userId: "steward-user-1",
      email: "user@example.com",
      tenantId: "elizacloud",
      expiration: issuedAt + 3600,
      issuedAt,
    });
    getByStewardIdForWrite.mockResolvedValue(refreshedUser());
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: true,
        token: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: issuedAt + 3600,
        expiresIn: 3600,
      }),
    ) as unknown as typeof fetch;
  });

  test("primary-checks the returned identity before installing rotated cookies", async () => {
    const response = await postCookieRefresh();

    expect(response.status).toBe(200);
    expect(getByStewardIdForWrite).toHaveBeenCalledWith("steward-user-1");
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toContain("steward-token=rotated-access-token");
    expect(cookies).toContain("steward-refresh-token=rotated-refresh-token");
  });

  test("does not reinstall a session when logout advances not-before during refresh", async () => {
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let finishLookup:
      | ((user: ReturnType<typeof refreshedUser>) => void)
      | undefined;
    const lookupResult = new Promise<ReturnType<typeof refreshedUser>>(
      (resolve) => {
        finishLookup = resolve;
      },
    );
    getByStewardIdForWrite.mockImplementationOnce(async () => {
      markLookupStarted?.();
      return await lookupResult;
    });

    const responsePromise = postCookieRefresh();
    await lookupStarted;
    finishLookup?.(refreshedUser(issuedAt + 1));
    const response = await responsePromise;

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid token",
      code: "invalid_token",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("fails closed when the primary authorization read is unavailable", async () => {
    getByStewardIdForWrite.mockRejectedValueOnce(
      new Error("primary unavailable"),
    );

    const response = await postCookieRefresh();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Session authorization unavailable",
      code: "internal_error",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("rejects a returned identity that does not own the primary user", async () => {
    getByStewardIdForWrite.mockResolvedValueOnce({
      ...refreshedUser(),
      steward_user_id: "different-steward-user",
    });

    const response = await postCookieRefresh();

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test.each([
    ["empty", () => new Response(null, { status: 200 })],
    [
      "malformed",
      () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "missing rotated refresh token",
      () => Response.json({ ok: true, token: "access-only" }),
    ],
  ])(
    "rejects an %s upstream success response",
    async (_name, responseFactory) => {
      globalThis.fetch = mock(async () =>
        responseFactory(),
      ) as unknown as typeof fetch;

      const response = await postCookieRefresh();

      expect(response.status).toBe(502);
      expect(getByStewardIdForWrite).not.toHaveBeenCalled();
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
});
