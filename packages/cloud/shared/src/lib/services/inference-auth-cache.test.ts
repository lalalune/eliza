/**
 * Pins the IAC entry shape guards against the real (mock-Redis) cache: positive
 * and rejection validators are mutually exclusive, so a hybrid entry carrying
 * both identity fields and a rejection decision is dropped as malformed instead
 * of resolving by field order into an authorization.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, test } from "bun:test";

const { cache } = await import("../cache/client");
const { CacheKeys } = await import("../cache/keys");
const {
  INFERENCE_AUTH_CONTEXT_VERSION,
  hashApiKey,
  invalidateInferenceAuthContextByKeyHash,
  invalidateInferenceSessionAuthContext,
  readInferenceAuthContextWithOutcome,
  readInferenceSessionAuthDecision,
  writeInferenceAuthContext,
  writeInferenceApiKeyAuthRejection,
  writeInferenceSessionAuthDecision,
} = await import("./inference-auth-cache");

const KEY_HASH = hashApiKey("eliza_validator_test_key");
const STEWARD_USER_ID = "steward-validator-1";
const SESSION_FINGERPRINT = hashApiKey("steward-validator-session");
const API_KEY_AUTHORIZATION = {
  v: 1,
  organizationId: "org-1",
  organizationRevision: "0",
  userId: "user-1",
  userRevision: "0",
  credential: {
    kind: "api_key",
    id: "key-1",
    fingerprint: KEY_HASH,
    revision: "0",
    expiresAt: null,
  },
} as const;
const SESSION_AUTHORIZATION = {
  v: 1,
  organizationId: "org-1",
  organizationRevision: "0",
  userId: "user-1",
  userRevision: "0",
  credential: {
    kind: "steward_session",
    id: SESSION_FINGERPRINT,
    fingerprint: SESSION_FINGERPRINT,
    revision: "0",
    expiresAt: Date.now() + 60_000,
  },
} as const;

beforeEach(async () => {
  await invalidateInferenceAuthContextByKeyHash(KEY_HASH);
  await invalidateInferenceSessionAuthContext(SESSION_FINGERPRINT);
});

describe("session decision validators", () => {
  test("a typed positive entry and a typed rejection both round-trip", async () => {
    await writeInferenceSessionAuthDecision({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: "user-1",
      orgId: "org-1",
      apiKeyId: null,
      stewardUserId: STEWARD_USER_ID,
      authorization: SESSION_AUTHORIZATION,
    });
    await expect(readInferenceSessionAuthDecision(SESSION_FINGERPRINT)).resolves.toMatchObject({
      userId: "user-1",
      orgId: "org-1",
      apiKeyId: null,
    });

    await writeInferenceSessionAuthDecision({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      stewardUserId: STEWARD_USER_ID,
      decision: "rejected",
      status: 401,
      credentialFingerprint: SESSION_FINGERPRINT,
    });
    await expect(readInferenceSessionAuthDecision(SESSION_FINGERPRINT)).resolves.toMatchObject({
      decision: "rejected",
      status: 401,
    });
  });

  test("a hybrid entry (identity fields + rejection decision) is dropped, never authorized", async () => {
    const key = CacheKeys.inference.sessionAuthContext(SESSION_FINGERPRINT);
    await cache.set(
      key,
      {
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: null,
        stewardUserId: STEWARD_USER_ID,
        authorization: SESSION_AUTHORIZATION,
        decision: "rejected",
        status: 403,
        credentialFingerprint: SESSION_FINGERPRINT,
      },
      60,
    );

    await expect(readInferenceSessionAuthDecision(SESSION_FINGERPRINT)).resolves.toBeNull();
    // The malformed entry was evicted, not left behind for a later read.
    await expect(cache.get(key)).resolves.toBeNull();
  });
});

describe("api-key IAC validators", () => {
  test("a typed positive entry and a typed rejection both round-trip", async () => {
    await writeInferenceAuthContext({
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: "user-1",
      orgId: "org-1",
      apiKeyId: "key-1",
      keyHash: KEY_HASH,
      authorization: API_KEY_AUTHORIZATION,
    });
    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "hit",
      ctx: { apiKeyId: "key-1", orgId: "org-1" },
    });

    await writeInferenceApiKeyAuthRejection(KEY_HASH, "suspended", 403);
    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "rejected",
      decision: "suspended",
      status: 403,
    });
  });

  test("a hybrid entry (identity fields + rejection decision) reads as invalid, never a hit", async () => {
    const key = CacheKeys.inference.authContext(KEY_HASH);
    await cache.set(
      key,
      {
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: "key-1",
        keyHash: KEY_HASH,
        authorization: API_KEY_AUTHORIZATION,
        decision: "rejected",
        status: 401,
      },
      60,
    );

    await expect(readInferenceAuthContextWithOutcome(KEY_HASH)).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(cache.get(key)).resolves.toBeNull();
  });
});
