/**
 * Exercises the real inference-session cache while replacing only the
 * authoritative user/moderation stores, proving cold hydration is detached and
 * warm session authorization performs no database service call.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, mock, test } from "bun:test";

let claims: {
  userId: string;
  email: string;
  expiration: number;
  issuedAt: number;
} | null;
let getUser:
  | (() => Promise<{
      id: string;
      is_active: boolean;
      organization_id: string;
      inference_auth_revision: number;
      inference_session_not_before: number;
      deleted_at: Date | null;
      organization: {
        id: string;
        is_active: boolean;
        inference_auth_revision: number;
      };
    }>)
  | undefined;
let userReads = 0;
let moderationReads = 0;

const actualStewardClient = await import("../auth/steward-client");
const actualUsers = await import("./users");
const actualAdmin = await import("./admin");
const actualStewardSync = await import("../steward-sync");

mock.module("../auth/steward-client", () => ({
  ...actualStewardClient,
  verifyStewardTokenCached: async () => claims,
}));

mock.module("./users", () => ({
  ...actualUsers,
  usersService: new Proxy(actualUsers.usersService, {
    get(target, property, receiver) {
      if (property !== "getByStewardIdForWrite") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        userReads++;
        return await getUser?.();
      };
    },
  }),
}));

mock.module("./admin", () => ({
  ...actualAdmin,
  adminService: new Proxy(actualAdmin.adminService, {
    get(target, property, receiver) {
      if (property !== "shouldBlockUser") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        moderationReads++;
        return false;
      };
    },
  }),
}));

mock.module("../steward-sync", () => ({
  ...actualStewardSync,
  syncUserFromSteward: async () => undefined,
}));

const {
  __clearInferenceSessionAuthHydrations,
  extractInferenceSessionCredential,
  resolveInferenceSessionAuthContext,
} = await import("./inference-session-auth-context");
const { hashInferenceSessionCredential, invalidateInferenceSessionAuthContext } = await import(
  "./inference-auth-cache"
);

const TOKEN = "header.payload.signature";

function request(): Request {
  return new Request("https://api.example/api/v1/chat/completions", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

beforeEach(async () => {
  __clearInferenceSessionAuthHydrations();
  claims = {
    userId: "steward-1",
    email: "person@example.test",
    expiration: Math.floor(Date.now() / 1000) + 300,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  userReads = 0;
  moderationReads = 0;
  getUser = async () => ({
    id: "user-1",
    is_active: true,
    organization_id: "org-1",
    inference_auth_revision: 0,
    inference_session_not_before: 0,
    deleted_at: null,
    organization: {
      id: "org-1",
      is_active: true,
      inference_auth_revision: 0,
    },
  });
  await invalidateInferenceSessionAuthContext(hashInferenceSessionCredential(TOKEN));
});

describe("extractInferenceSessionCredential", () => {
  test("JWT bearer takes precedence over the environment-owned cookie", () => {
    const req = new Request("https://api.example/api/v1/chat/completions", {
      headers: {
        authorization: "Bearer bearer.payload.signature",
        cookie: "steward-token=cookie.payload.signature",
      },
    });

    expect(
      extractInferenceSessionCredential(req, {
        environment: "production",
        environmentOwnedCookieOnly: true,
      }),
    ).toBe("bearer.payload.signature");
  });

  test("eliza API-key bearer does not fall through to a Steward cookie", () => {
    const req = new Request("https://api.example/api/v1/chat/completions", {
      headers: {
        authorization: "Bearer eliza_test-api-key",
        cookie: "steward-token=cookie.payload.signature",
      },
    });

    expect(
      extractInferenceSessionCredential(req, {
        environment: "production",
        environmentOwnedCookieOnly: true,
      }),
    ).toBeNull();
  });

  test("mutation mode rejects another environment's legacy cookie", () => {
    const legacyOnly = new Request("https://api.example/api/v1/chat/completions", {
      headers: { cookie: "steward-token=production.payload.signature" },
    });
    const stagingOwned = new Request("https://api.example/api/v1/chat/completions", {
      headers: {
        cookie:
          "steward-token=production.payload.signature; steward-token-staging=staging.payload.signature",
      },
    });

    expect(
      extractInferenceSessionCredential(legacyOnly, {
        environment: "staging",
        environmentOwnedCookieOnly: true,
      }),
    ).toBeNull();
    expect(
      extractInferenceSessionCredential(stagingOwned, {
        environment: "staging",
        environmentOwnedCookieOnly: true,
      }),
    ).toBe("staging.payload.signature");
  });
});

describe("resolveInferenceSessionAuthContext", () => {
  test("cold Worker request returns warming without joining authoritative hydration", async () => {
    let releaseUser = (): void => {};
    getUser = async () =>
      await new Promise((resolve) => {
        releaseUser = () =>
          resolve({
            id: "user-1",
            is_active: true,
            organization_id: "org-1",
            inference_auth_revision: 0,
            inference_session_not_before: 0,
            deleted_at: null,
            organization: {
              id: "org-1",
              is_active: true,
              inference_auth_revision: 0,
            },
          });
      });
    const waited: Promise<unknown>[] = [];

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });

    expect(result).toEqual({ kind: "warming" });
    expect(waited).toHaveLength(1);
    expect(userReads).toBe(1);
    expect(moderationReads).toBe(0);

    releaseUser();
    await Promise.all(waited);
    expect(moderationReads).toBe(1);
  });

  test("warm verified session reads the combined cache and never calls users or moderation", async () => {
    const waited: Promise<unknown>[] = [];
    await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    await Promise.all(waited);
    userReads = 0;
    moderationReads = 0;

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
    });

    expect(result).toMatchObject({
      kind: "authorized",
      source: "cache",
      ctx: {
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: null,
        stewardUserId: "steward-1",
      },
    });
    expect(userReads).toBe(0);
    expect(moderationReads).toBe(0);
  });

  test("concurrent cold requests share one authoritative hydration", async () => {
    const releaseUser = Promise.withResolvers<void>();
    getUser = async () => {
      await releaseUser.promise;
      return {
        id: "user-1",
        is_active: true,
        organization_id: "org-1",
        inference_auth_revision: 0,
        inference_session_not_before: 0,
        deleted_at: null,
        organization: {
          id: "org-1",
          is_active: true,
          inference_auth_revision: 0,
        },
      };
    };
    const firstWaited: Promise<unknown>[] = [];
    const secondWaited: Promise<unknown>[] = [];

    const [first, second] = await Promise.all([
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => firstWaited.push(promise) },
      }),
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => secondWaited.push(promise) },
      }),
    ]);

    expect(first).toEqual({ kind: "warming" });
    expect(second).toEqual({ kind: "warming" });
    expect(userReads).toBe(1);
    expect(firstWaited).toHaveLength(1);
    expect(secondWaited).toHaveLength(1);

    releaseUser.resolve();
    await Promise.all([...firstWaited, ...secondWaited]);
    expect(moderationReads).toBe(1);
  });

  test("invalid session is rejected without authoritative hydration", async () => {
    claims = null;

    await expect(
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: () => undefined },
      }),
    ).resolves.toEqual({ kind: "rejected", status: 401 });
    expect(userReads).toBe(0);
    expect(moderationReads).toBe(0);
  });

  test("does not republish a JWT issued before the user's revocation boundary", async () => {
    if (!claims) throw new Error("test claims are missing");
    const issuedAt = claims.issuedAt;
    getUser = async () => ({
      id: "user-1",
      is_active: true,
      organization_id: "org-1",
      inference_auth_revision: 0,
      inference_session_not_before: issuedAt + 1,
      deleted_at: null,
      organization: {
        id: "org-1",
        is_active: true,
        inference_auth_revision: 0,
      },
    });
    const waited: Promise<unknown>[] = [];

    expect(
      await resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).toEqual({ kind: "warming" });
    await Promise.all(waited);

    await expect(
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
      }),
    ).resolves.toEqual({ kind: "rejected", status: 401 });
  });
});
