/**
 * Cache cleanup reports incomplete API-key eviction.
 *
 * Lifecycle mutations use the inference admission Durable Object as their
 * authorization boundary, while this lower-level helper keeps validation and
 * positive-auth caches from retaining stale data for their full TTL.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ApiKey } from "../../db/repositories";
import { apiKeysRepository } from "../../db/repositories";
import { cache } from "../cache/client";
import { CacheKeys } from "../cache/keys";
import { apiKeysService } from "./api-keys";

const KEY_HASH = "a".repeat(64);
const SHORT_HASH = KEY_HASH.substring(0, 16);
const VALIDATION_KEY = CacheKeys.apiKey.validation(KEY_HASH);
const LEGACY_VALIDATION_KEY = CacheKeys.apiKey.legacyValidation(SHORT_HASH);

function fakeKey(): ApiKey {
  return {
    id: "key-1",
    key_hash: KEY_HASH,
    organization_id: "org-1",
    user_id: "user-1",
    is_active: true,
  } as unknown as ApiKey;
}

describe("apiKeysService.invalidateCache fails closed (#13417)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  test("both deletes confirmed -> resolves quietly", async () => {
    const del = track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    await expect(apiKeysService.invalidateCache(KEY_HASH)).resolves.toBeUndefined();
    // clears both the validation entry and the inference auth-context entry
    expect(del).toHaveBeenCalledWith(VALIDATION_KEY);
    expect(del).toHaveBeenCalledWith(LEGACY_VALIDATION_KEY);
    expect(del.mock.calls.length).toBe(3);
  });

  test("validation-cache delete unconfirmed -> throws (revoked key would keep authenticating)", async () => {
    track(
      spyOn(cache, "delConfirmed").mockImplementation(
        // validation entry delete fails, inference one succeeds
        async (key: string) => key !== VALIDATION_KEY,
      ),
    );
    await expect(apiKeysService.invalidateCache(KEY_HASH)).rejects.toThrow(/not confirmed/i);
  });

  test("inference auth-context delete unconfirmed -> throws", async () => {
    track(
      spyOn(cache, "delConfirmed").mockImplementation(
        // inference entry (not the validation key) fails
        async (key: string) => key === VALIDATION_KEY || key === LEGACY_VALIDATION_KEY,
      ),
    );
    await expect(apiKeysService.invalidateCache(KEY_HASH)).rejects.toThrow(/not confirmed/i);
  });

  test("invalidateInferenceContextForUser: unconfirmed fan-out throws (ban fails closed)", async () => {
    track(
      spyOn(apiKeysRepository, "listByUser").mockResolvedValue([
        fakeKey(),
        { ...fakeKey(), key_hash: "b".repeat(64) } as ApiKey,
      ]),
    );
    // second key's IAC delete is unconfirmed
    track(
      spyOn(cache, "delConfirmed").mockImplementation(
        async (key: string) => !key.includes("b".repeat(64)),
      ),
    );
    await expect(apiKeysService.invalidateInferenceContextForUser("user-1")).rejects.toThrow(
      /not confirmed/i,
    );
  });

  test("invalidateInferenceContextForUser: all confirmed resolves", async () => {
    track(spyOn(apiKeysRepository, "listByUser").mockResolvedValue([fakeKey()]));
    track(spyOn(cache, "delConfirmed").mockResolvedValue(true));
    await expect(
      apiKeysService.invalidateInferenceContextForUser("user-1"),
    ).resolves.toBeUndefined();
  });
});

describe("apiKeysService.validateApiKey exact credential cache identity", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  test("uses the full SHA-256 key and accepts only a matching cached row", async () => {
    const rawKey = "eliza_full_hash_cache_test";
    const fullHash = createHash("sha256").update(rawKey).digest("hex");
    const cached = { ...fakeKey(), key_hash: fullHash };
    const get = track(spyOn(cache, "get").mockResolvedValue(cached));
    const replica = track(
      spyOn(apiKeysRepository, "findActiveByHash").mockResolvedValue(undefined),
    );

    await expect(apiKeysService.validateApiKey(rawKey)).resolves.toEqual(cached);
    expect(get).toHaveBeenCalledWith(CacheKeys.apiKey.validation(fullHash));
    expect(replica).not.toHaveBeenCalled();
  });

  test("rejects a cache row whose embedded full hash names another credential", async () => {
    const rawKey = "eliza_corrupt_cache_test";
    const fullHash = createHash("sha256").update(rawKey).digest("hex");
    const get = track(
      spyOn(cache, "get").mockResolvedValue({
        ...fakeKey(),
        key_hash: `${fullHash.slice(0, 16)}${"f".repeat(48)}`,
      }),
    );
    const del = track(spyOn(cache, "del").mockResolvedValue(undefined));
    track(spyOn(cache, "set").mockResolvedValue(undefined));
    track(spyOn(apiKeysRepository, "findActiveByHash").mockResolvedValue(undefined));
    track(spyOn(apiKeysRepository, "findActiveByHashConsistent").mockResolvedValue(undefined));

    await expect(apiKeysService.validateApiKey(rawKey)).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(CacheKeys.apiKey.validation(fullHash));
    expect(del).toHaveBeenCalledWith(CacheKeys.apiKey.validation(fullHash));
  });
});
