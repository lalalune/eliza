/**
 * API-key issuance, validation, and lifecycle authorization.
 *
 * Postgres owns credential state, while the organization's inference admission
 * Durable Object is the synchronous revocation boundary for cache-authorized
 * provider dispatch. Cache eviction is cleanup after that boundary is updated.
 */

import { ElizaError } from "@elizaos/core";
import crypto from "crypto";
import { and, eq, inArray, isNull, like, lt, sql } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { encryptApiKey } from "../../db/crypto/api-keys";
import { type ApiKey, apiKeysRepository, type NewApiKey } from "../../db/repositories";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { API_KEY_PREFIX_LENGTH } from "../pricing";
import { logger } from "../utils/logger";
import {
  invalidateInferenceAuthContextByKeyHash,
  invalidateInferenceAuthContextsByKeyHashes,
} from "./inference-auth-cache";
import {
  applyInferenceAuthorizationState,
  applyInferenceAuthorizationStates,
  type InferenceAuthorizationTargetState,
} from "./inference-authorization-boundary";
import { apiKeyAuthorizationState } from "./inference-authorization-lifecycle";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_API_KEY_PREFIX = "agent-sandbox:";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isCacheableApiKey(value: unknown): value is ApiKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isUuid(candidate.id) &&
    isUuid(candidate.organization_id) &&
    isUuid(candidate.user_id) &&
    typeof candidate.key_hash === "string" &&
    typeof candidate.key_prefix === "string" &&
    typeof candidate.is_active === "boolean"
  );
}

/**
 * Sentinel for negative-cached API key validation lookups.
 * We can't cache `null` directly through `cache.set` (the client treats it as
 * an invalid value), so we store a small marker object and check for it.
 *
 * Negative caching protects the DB from being hammered when an attacker (or
 * a misconfigured client) repeatedly sends the same bogus key.
 */
const API_KEY_NEGATIVE_SENTINEL = { __none: true } as const;
const API_KEY_NEGATIVE_TTL_SECONDS = 60;

function isNegativeApiKeySentinel(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = Object.getOwnPropertyDescriptor(value, "__none");
  return marker !== undefined && Object.is(marker.value, API_KEY_NEGATIVE_SENTINEL.__none);
}

/**
 * Per-process debounce of api-key usage_count writes.
 * Avoids one DB write per authenticated request while still surfacing recency.
 * We do NOT use Redis here because the goal is just to coalesce; eventual
 * convergence across processes is fine for usage telemetry.
 */
const USAGE_INCREMENT_DEBOUNCE_MS = 60_000;
const lastUsageIncrement = new Map<string, number>();

type ApiKeyCreateInput = Omit<
  NewApiKey,
  | "key_hash"
  | "key_prefix"
  | "key_ciphertext"
  | "key_nonce"
  | "key_auth_tag"
  | "key_kms_key_id"
  | "key_kms_key_version"
  | "inference_auth_revision"
>;

interface OrganizationAuthorizationState {
  organizationId: string;
  state: InferenceAuthorizationTargetState;
}

const AUTHORIZATION_FIELDS = [
  "id",
  "organization_id",
  "user_id",
  "key_hash",
  "is_active",
  "deleted_at",
  "expires_at",
] as const satisfies readonly (keyof NewApiKey)[];

function apiKeyAuthorizationRequested(data: Partial<NewApiKey>): boolean {
  return AUTHORIZATION_FIELDS.some((field) => Object.hasOwn(data, field));
}

function dateValue(value: Date | null): number | null {
  return value?.getTime() ?? null;
}

function apiKeyAuthorizationChanged(existing: ApiKey, updated: ApiKey): boolean {
  return (
    existing.id !== updated.id ||
    existing.organization_id !== updated.organization_id ||
    existing.user_id !== updated.user_id ||
    existing.key_hash !== updated.key_hash ||
    existing.is_active !== updated.is_active ||
    dateValue(existing.deleted_at) !== dateValue(updated.deleted_at) ||
    dateValue(existing.expires_at) !== dateValue(updated.expires_at)
  );
}

function apiKeyIdentityChanged(existing: ApiKey, updated: ApiKey): boolean {
  return (
    existing.id !== updated.id ||
    existing.organization_id !== updated.organization_id ||
    existing.user_id !== updated.user_id ||
    existing.key_hash !== updated.key_hash
  );
}

function apiKeyDenied(apiKey: ApiKey): boolean {
  const expiresAt = dateValue(apiKey.expires_at);
  return (
    !apiKey.is_active ||
    apiKey.deleted_at !== null ||
    (expiresAt !== null && expiresAt <= Date.now())
  );
}

function expiryContracted(existing: ApiKey, updated: ApiKey): boolean {
  const existingExpiry = dateValue(existing.expires_at) ?? Number.POSITIVE_INFINITY;
  const updatedExpiry = dateValue(updated.expires_at) ?? Number.POSITIVE_INFINITY;
  return updatedExpiry < existingExpiry;
}

function deniedCredentialState(
  apiKey: ApiKey,
  revision: ApiKey["inference_auth_revision"],
): InferenceAuthorizationTargetState {
  return apiKeyAuthorizationState({
    ...apiKey,
    inference_auth_revision: revision,
    is_active: false,
  });
}

function authorizationUpdatePlan(
  existing: ApiKey,
  updated: ApiKey,
): {
  restrictive: OrganizationAuthorizationState[];
  permissive: OrganizationAuthorizationState | null;
} {
  if (!apiKeyAuthorizationChanged(existing, updated)) {
    return { restrictive: [], permissive: null };
  }

  const current = {
    organizationId: updated.organization_id,
    state: apiKeyAuthorizationState(updated),
  };
  if (!apiKeyIdentityChanged(existing, updated)) {
    if (apiKeyDenied(updated) || expiryContracted(existing, updated)) {
      return { restrictive: [current], permissive: null };
    }
    return { restrictive: [], permissive: current };
  }

  const previous = {
    organizationId: existing.organization_id,
    state: deniedCredentialState(existing, updated.inference_auth_revision),
  };
  if (!apiKeyDenied(updated)) {
    return { restrictive: [previous], permissive: current };
  }

  if (
    previous.organizationId === current.organizationId &&
    previous.state.id === current.state.id
  ) {
    return { restrictive: [current], permissive: null };
  }
  return { restrictive: [previous, current], permissive: null };
}

async function applyAuthorizationStateGroups(
  updates: readonly OrganizationAuthorizationState[],
): Promise<void> {
  const statesByOrganization = new Map<string, InferenceAuthorizationTargetState[]>();
  for (const update of updates) {
    const states = statesByOrganization.get(update.organizationId) ?? [];
    states.push(update.state);
    statesByOrganization.set(update.organizationId, states);
  }
  for (const [organizationId, states] of statesByOrganization) {
    for (let offset = 0; offset < states.length; offset += 512) {
      await applyInferenceAuthorizationStates(organizationId, states.slice(offset, offset + 512));
    }
  }
}

/**
 * Generated API key with hash and prefix.
 */
export interface GeneratedApiKey {
  key: string;
  hash: string;
  prefix: string;
}

/**
 * Service for managing API keys including generation, validation, and CRUD operations.
 */
export class ApiKeysService {
  generateApiKey(): GeneratedApiKey {
    const randomBytes = crypto.randomBytes(32).toString("hex");
    const key = `eliza_${randomBytes}`;
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const prefix = key.substring(0, API_KEY_PREFIX_LENGTH);

    return { key, hash, prefix };
  }

  /**
   * Validate an API key with Redis caching.
   * Uses a 10-minute cache for valid keys and a 60-second negative cache for
   * unknown keys to reduce database load while maintaining security.
   */
  async validateApiKey(key: string): Promise<ApiKey | null> {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const cacheKey = CacheKeys.apiKey.validation(hash);

    const cached = await cache.get<unknown>(cacheKey);
    if (cached) {
      if (isNegativeApiKeySentinel(cached)) {
        logger.debug("[ApiKeys] Cache hit for negative API key validation");
        return null;
      }
      if (isCacheableApiKey(cached) && cached.key_hash === hash) {
        logger.debug("[ApiKeys] Cache hit for API key validation");
        return cached;
      }
      await cache.del(cacheKey);
      logger.warn("[ApiKeys] Dropped invalid API key validation cache entry", {
        cacheKey,
      });
    }

    const replicaApiKey = await apiKeysRepository.findActiveByHash(hash);
    const primaryApiKey = replicaApiKey
      ? undefined
      : await apiKeysRepository.findActiveByHashConsistent(hash);
    const apiKey = replicaApiKey ?? primaryApiKey;

    if (apiKey) {
      await cache.set(cacheKey, apiKey, CacheTTL.apiKey.validation);
      logger.debug("[ApiKeys] Cached valid API key", {
        keyPrefix: apiKey.key_prefix,
      });
      return apiKey;
    }

    // Negative cache: prevent a flood of bad keys from hammering the DB.
    // Short TTL so a freshly-created key isn't blocked by a stale negative entry
    // from a recent typo'd attempt.
    await cache.set(cacheKey, API_KEY_NEGATIVE_SENTINEL, API_KEY_NEGATIVE_TTL_SECONDS);
    return null;
  }

  /**
   * Increment usage_count for an API key with per-process debouncing.
   *
   * Without debouncing, every authenticated API request triggers a DB write.
   * On the hot inference paths (/v1/messages, /v1/chat/completions) that's
   * one extra round-trip per request — for telemetry that doesn't need
   * single-request precision. We coalesce writes to once per minute per key.
   */
  async incrementUsageDebounced(id: string): Promise<void> {
    const now = Date.now();
    const last = lastUsageIncrement.get(id) ?? 0;
    if (now - last < USAGE_INCREMENT_DEBOUNCE_MS) return;

    lastUsageIncrement.set(id, now);

    // Cap the map so a long-running worker with many keys doesn't grow forever.
    if (lastUsageIncrement.size > 10_000) {
      const cutoff = now - USAGE_INCREMENT_DEBOUNCE_MS * 2;
      for (const [keyId, ts] of lastUsageIncrement) {
        if (ts < cutoff) lastUsageIncrement.delete(keyId);
      }
    }

    await apiKeysRepository.incrementUsage(id);
  }

  /**
   * Delete validation and inference cache entries for one credential.
   *
   * Lifecycle methods invoke this after the Durable Object observes the
   * authoritative transition, so a cleanup failure cannot reopen inference.
   * The explicit throw keeps incomplete cache maintenance observable to direct
   * callers and to the lifecycle wrapper's structured warning.
   */
  async invalidateCache(keyHash: string): Promise<void> {
    const shortHash = keyHash.substring(0, 16);
    const [validationDeleted, legacyValidationDeleted, inferenceDeleted] = await Promise.all([
      cache.delConfirmed(CacheKeys.apiKey.validation(keyHash)),
      cache.delConfirmed(CacheKeys.apiKey.legacyValidation(shortHash)),
      invalidateInferenceAuthContextByKeyHash(keyHash),
    ]);

    if (!validationDeleted || !legacyValidationDeleted || !inferenceDeleted) {
      const unconfirmed = [
        validationDeleted ? null : "validation",
        legacyValidationDeleted ? null : "legacy-validation",
        inferenceDeleted ? null : "inference-auth-context",
      ].filter((entry): entry is string => entry !== null);
      logger.error("[ApiKeys] API key cache invalidation not confirmed", {
        shortHash,
        unconfirmed,
      });
      throw new ElizaError("API key cache invalidation was not confirmed", {
        code: "API_KEY_CACHE_INVALIDATION_UNCONFIRMED",
        context: { shortHash, unconfirmed },
        severity: "ephemeral",
      });
    }

    logger.debug("[ApiKeys] Invalidated API key + inference auth-context cache");
  }

  async getById(id: string): Promise<ApiKey | undefined> {
    return await apiKeysRepository.findById(id);
  }

  async listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return await apiKeysRepository.listByOrganization(organizationId);
  }

  async listByUser(userId: string): Promise<ApiKey[]> {
    return await apiKeysRepository.listByUser(userId);
  }

  /**
   * Invalidate the inference auth-context cache for ALL of a user's API keys
   * (#9899). Called when a user is banned/suspended/deactivated: the caller has
   * only the user_id, so we resolve the user's key hashes and clear each IAC
   * entry. Best-effort - bounded ultimately by the IAC TTL.
   */
  async invalidateInferenceContextForUser(userId: string): Promise<void> {
    const keys = await apiKeysRepository.listByUser(userId);
    await invalidateInferenceAuthContextsByKeyHashes(keys.map((k) => k.key_hash));
  }

  async create(data: ApiKeyCreateInput): Promise<{
    apiKey: ApiKey;
    plainKey: string;
  }> {
    const { apiKey, plainKey } = await this.buildApiKeyInsert(data);
    const created = await apiKeysRepository.create(apiKey);
    await applyInferenceAuthorizationState(
      created.organization_id,
      apiKeyAuthorizationState(created),
    );

    return {
      apiKey: created,
      plainKey,
    };
  }

  private async buildApiKeyInsert(
    data: ApiKeyCreateInput,
  ): Promise<{ apiKey: NewApiKey; plainKey: string }> {
    const { key, hash, prefix } = this.generateApiKey();

    // Pre-allocate the row id so the encryption AAD can bind to it.
    const rowId = crypto.randomUUID();
    const encrypted = await encryptApiKey(data.organization_id, rowId, key);

    return {
      apiKey: {
        ...data,
        id: rowId,
        key_hash: hash,
        key_prefix: prefix,
        key_ciphertext: encrypted.ciphertext,
        key_nonce: encrypted.nonce,
        key_auth_tag: encrypted.auth_tag,
        key_kms_key_id: encrypted.kms_key_id,
        key_kms_key_version: encrypted.kms_key_version,
      },
      plainKey: key,
    };
  }

  /**
   * Required default-key provisioning for flows that must not report success
   * until the user has a usable personal key in the target organization.
   * The transaction takes a per-user/org advisory lock and re-checks the
   * primary connection before inserting, so concurrent accept/sync paths cannot
   * mint duplicate default keys.
   */
  async provisionDefaultApiKey(userId: string, organizationId: string): Promise<void> {
    if (!userId?.trim() || !organizationId?.trim()) {
      throw new Error("Invalid userId or organizationId for default API key provisioning");
    }

    const key = await dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`default_api_key:${userId}:${organizationId}`}))`,
      );

      const now = new Date();
      const existingKeys = await tx
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.user_id, userId),
            eq(apiKeys.organization_id, organizationId),
            eq(apiKeys.name, "Default API Key"),
            eq(apiKeys.is_active, true),
            isNull(apiKeys.deleted_at),
          ),
        )
        .for("update");
      const existing = existingKeys.find((candidate) => {
        return !candidate.expires_at || candidate.expires_at > now;
      });
      if (existing) {
        return existing;
      }

      const { apiKey } = await this.buildApiKeyInsert({
        user_id: userId,
        organization_id: organizationId,
        name: "Default API Key",
        is_active: true,
      });
      const [created] = await tx.insert(apiKeys).values(apiKey).returning();
      if (!created) {
        throw new ElizaError("Default API key insert did not return its row", {
          code: "API_KEY_DEFAULT_INSERT_FAILED",
          context: { userId, organizationId },
        });
      }
      return created;
    });
    await applyInferenceAuthorizationState(key.organization_id, apiKeyAuthorizationState(key));
  }

  /**
   * Best-effort default-key self-heal for session resolution. Provisioning
   * surfaces call `provisionDefaultApiKey` so they fail honestly; this wrapper
   * keeps older session-cache-miss repair observable without taking down auth.
   */
  async ensureUserHasApiKey(userId: string, organizationId: string): Promise<void> {
    if (!userId?.trim() || !organizationId?.trim()) {
      logger.warn("[ApiKeysService] Invalid userId or organizationId, skipping default key", {
        userId,
        organizationId,
      });
      return;
    }

    try {
      await this.provisionDefaultApiKey(userId, organizationId);
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop: this session heal
      // is a retry path for older broken accounts; signup/invite call the strict
      // provisioner and fail before reporting success.
      logger.error("[ApiKeysService] Failed to provision default API key", {
        userId,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async update(id: string, data: Partial<NewApiKey>): Promise<ApiKey | undefined> {
    const updateData = { ...data };
    delete updateData.inference_auth_revision;
    const authorizationRequested = apiKeyAuthorizationRequested(updateData);
    const result = await dbWrite.transaction(async (tx) => {
      const [existing] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).for("update");
      if (!existing) return undefined;

      const candidate = { ...existing, ...updateData };
      const authorizationChanged = apiKeyAuthorizationChanged(existing, candidate);
      let [updated] = await tx
        .update(apiKeys)
        .set({
          ...updateData,
          ...(authorizationChanged
            ? {
                inference_auth_revision: sql`${apiKeys.inference_auth_revision} + 1`,
              }
            : {}),
          updated_at: new Date(),
        })
        .where(eq(apiKeys.id, id))
        .returning();
      if (!updated) {
        throw new ElizaError("API key disappeared during update", {
          code: "API_KEY_UPDATE_LOST",
          context: { apiKeyId: id },
        });
      }
      const plan = authorizationUpdatePlan(existing, updated);
      if (authorizationRequested && plan.restrictive.length === 0 && plan.permissive === null) {
        const current = {
          organizationId: updated.organization_id,
          state: apiKeyAuthorizationState(updated),
        };
        if (apiKeyDenied(updated)) {
          plan.restrictive.push(current);
        } else {
          plan.permissive = current;
        }
      }
      await applyAuthorizationStateGroups(plan.restrictive);
      if (
        plan.permissive &&
        plan.restrictive.some((restriction) => {
          return (
            restriction.organizationId === plan.permissive?.organizationId &&
            restriction.state.kind === "credential" &&
            plan.permissive.state.kind === "credential" &&
            restriction.state.id === plan.permissive.state.id &&
            restriction.state.credentialKind === plan.permissive.state.credentialKind
          );
        })
      ) {
        const [advanced] = await tx
          .update(apiKeys)
          .set({
            inference_auth_revision: sql`${apiKeys.inference_auth_revision} + 1`,
            updated_at: new Date(),
          })
          .where(eq(apiKeys.id, updated.id))
          .returning();
        if (!advanced) {
          throw new ElizaError("API key disappeared while advancing authorization", {
            code: "API_KEY_AUTH_REVISION_ADVANCE_LOST",
            context: { apiKeyId: updated.id },
          });
        }
        updated = advanced;
        plan.permissive = {
          organizationId: advanced.organization_id,
          state: apiKeyAuthorizationState(advanced),
        };
      }
      return { existing, updated, permissive: plan.permissive };
    });
    if (!result) return undefined;
    if (result.permissive) {
      await applyInferenceAuthorizationState(
        result.permissive.organizationId,
        result.permissive.state,
      );
    }
    await this.invalidateCachesAfterAuthorization([
      result.existing.key_hash,
      result.updated.key_hash,
    ]);
    return result.updated;
  }

  async incrementUsage(id: string): Promise<void> {
    await apiKeysRepository.incrementUsage(id);
  }

  async delete(id: string): Promise<void> {
    const deleted = await dbWrite.transaction(async (tx) => {
      const [existing] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).for("update");
      if (!existing) return undefined;
      const [restricted] = await tx
        .update(apiKeys)
        .set({
          is_active: false,
          deleted_at: existing.deleted_at ?? new Date(),
          inference_auth_revision: sql`${apiKeys.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(eq(apiKeys.id, id))
        .returning();
      if (!restricted) {
        throw new ElizaError("API key disappeared during deletion", {
          code: "API_KEY_DELETE_LOST",
          context: { apiKeyId: id },
        });
      }
      await applyInferenceAuthorizationState(
        restricted.organization_id,
        apiKeyAuthorizationState(restricted),
      );
      await tx.delete(apiKeys).where(eq(apiKeys.id, restricted.id));
      return restricted;
    });
    if (deleted) {
      await this.invalidateCachesAfterAuthorization([deleted.key_hash]);
    }
  }

  async deactivateUserKeysByName(userId: string, name: string): Promise<void> {
    const restricted = await dbWrite.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(apiKeys)
        .where(
          and(eq(apiKeys.user_id, userId), eq(apiKeys.name, name), eq(apiKeys.is_active, true)),
        )
        .for("update");
      if (existing.length === 0) return [];
      const updated = await tx
        .update(apiKeys)
        .set({
          is_active: false,
          inference_auth_revision: sql`${apiKeys.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(
          inArray(
            apiKeys.id,
            existing.map((key) => key.id),
          ),
        )
        .returning();
      await applyAuthorizationStateGroups(
        updated.map((key) => ({
          organizationId: key.organization_id,
          state: apiKeyAuthorizationState(key),
        })),
      );
      return updated;
    });
    await this.invalidateCachesAfterAuthorization(restricted.map((key) => key.key_hash));
  }

  async deactivateByUserAndOrganization(userId: string, organizationId: string): Promise<void> {
    const restricted = await dbWrite.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.user_id, userId),
            eq(apiKeys.organization_id, organizationId),
            eq(apiKeys.is_active, true),
          ),
        )
        .for("update");
      if (existing.length === 0) return [];
      const updated = await tx
        .update(apiKeys)
        .set({
          is_active: false,
          inference_auth_revision: sql`${apiKeys.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(
          inArray(
            apiKeys.id,
            existing.map((key) => key.id),
          ),
        )
        .returning();
      await applyInferenceAuthorizationStates(
        organizationId,
        updated.map((key) => apiKeyAuthorizationState(key)),
      );
      return updated;
    });
    await this.invalidateCachesAfterAuthorization(restricted.map((key) => key.key_hash));
  }

  // Sandbox-scoped keys are named "agent-sandbox:<id>". Listing/revoking by that
  // canonical name is enough — no need for a separate metadata column today.
  private static agentApiKeyName(agentSandboxId: string): string {
    return `${AGENT_API_KEY_PREFIX}${agentSandboxId}`;
  }

  async createForAgent(params: {
    organizationId: string;
    userId: string;
    agentSandboxId: string;
  }): Promise<{ apiKey: ApiKey; plainKey: string }> {
    const name = ApiKeysService.agentApiKeyName(params.agentSandboxId);

    // Idempotency: a re-run of the provisioner must not strand an old key
    // active. Revoke whatever was previously bound to this sandbox before
    // minting a fresh one.
    await this.revokeForAgent(params.agentSandboxId);

    return await this.create({
      name,
      description: `Auto-generated sandbox key for agent ${params.agentSandboxId}`,
      organization_id: params.organizationId,
      user_id: params.userId,
      rate_limit: 1000,
      is_active: true,
      expires_at: null,
    });
  }

  async revokeForAgent(agentSandboxId: string): Promise<void> {
    const name = ApiKeysService.agentApiKeyName(agentSandboxId);
    const deleted = await dbWrite.transaction(async (tx) => {
      const existing = await tx.select().from(apiKeys).where(eq(apiKeys.name, name)).for("update");
      if (existing.length === 0) return [];
      const restricted = await tx
        .update(apiKeys)
        .set({
          is_active: false,
          deleted_at: new Date(),
          inference_auth_revision: sql`${apiKeys.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(
          inArray(
            apiKeys.id,
            existing.map((key) => key.id),
          ),
        )
        .returning();
      await applyAuthorizationStateGroups(
        restricted.map((key) => ({
          organizationId: key.organization_id,
          state: apiKeyAuthorizationState(key),
        })),
      );
      await tx.delete(apiKeys).where(
        inArray(
          apiKeys.id,
          restricted.map((key) => key.id),
        ),
      );
      return restricted;
    });
    await this.invalidateCachesAfterAuthorization(deleted.map((key) => key.key_hash));
  }

  async revokeStrandedAgentKeys(olderThan: Date): Promise<ApiKey[]> {
    const deleted = await dbWrite.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.is_active, true),
            like(apiKeys.name, `${AGENT_API_KEY_PREFIX}%`),
            lt(apiKeys.created_at, olderThan),
            sql`NOT EXISTS (
              SELECT 1 FROM ${agentSandboxes}
              WHERE ${agentSandboxes.id}::text = substring(
                ${apiKeys.name} from ${sql.raw(String(AGENT_API_KEY_PREFIX.length + 1))}
              )
            )`,
          ),
        )
        .for("update");
      if (existing.length === 0) return [];
      const restricted = await tx
        .update(apiKeys)
        .set({
          is_active: false,
          deleted_at: new Date(),
          inference_auth_revision: sql`${apiKeys.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(
          inArray(
            apiKeys.id,
            existing.map((key) => key.id),
          ),
        )
        .returning();
      await applyAuthorizationStateGroups(
        restricted.map((key) => ({
          organizationId: key.organization_id,
          state: apiKeyAuthorizationState(key),
        })),
      );
      await tx.delete(apiKeys).where(
        inArray(
          apiKeys.id,
          restricted.map((key) => key.id),
        ),
      );
      return restricted;
    });
    await this.invalidateCachesAfterAuthorization(deleted.map((key) => key.key_hash));
    return deleted;
  }

  private async invalidateCachesAfterAuthorization(keyHashes: readonly string[]): Promise<void> {
    for (const keyHash of new Set(keyHashes)) {
      try {
        await this.invalidateCache(keyHash);
      } catch (error) {
        // error-policy:J7 the admission Durable Object already observes this
        // credential transition; eviction only shortens stale-cache residency.
        logger.warn("[ApiKeys] Post-authorization cache cleanup was not confirmed", {
          keyHashPrefix: keyHash.substring(0, 16),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// Export singleton instance
export const apiKeysService = new ApiKeysService();
