/**
 * Users service for managing user accounts and organization relationships.
 */

import { eq, sql } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import {
  apiKeysRepository,
  type NewUser,
  organizationsRepository,
  type User,
  type UserWithOrganization,
  usersRepository,
} from "../../db/repositories";
import { retryOnTransientDbError } from "../../db/retry-transient";
import { users } from "../../db/schemas/users";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { invalidateInferenceAuthContextsByKeyHashes } from "./inference-auth-cache";
import { applyInferenceAuthorizationState } from "./inference-authorization-boundary";
import {
  stewardSessionAuthorizationState,
  userAuthorizationState,
} from "./inference-authorization-lifecycle";

function getErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: (error as Error & { code?: string }).code,
    cause: error.cause ? getErrorDetails(error.cause) : undefined,
  };
}

/**
 * Personal-org slug for a detached member — mirrors the signup generators in
 * steward-sync.ts (email local-part / wallet prefix / name + entropy suffix).
 */
function generatePersonalOrgSlug(user: User): string {
  const base = user.email
    ? user.email.split("@")[0]
    : user.wallet_address
      ? `wallet-${user.wallet_address.substring(0, 8)}`
      : user.name || "user";
  const sanitized = base.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${sanitized}-${timestamp}${random}`;
}

/**
 * Service for user operations including organization lookups.
 */
export class UsersService {
  /**
   * Move the earliest accepted Steward JWT issue time beyond every token
   * minted so far. The Durable Object transition happens before the database
   * commit, so a rollback can only leave inference more restrictive.
   */
  async revokeInferenceSessions(
    userId: string,
    credentialIssuedAt?: number,
  ): Promise<User> {
    if (
      credentialIssuedAt !== undefined &&
      (!Number.isSafeInteger(credentialIssuedAt) ||
        credentialIssuedAt < 0 ||
        credentialIssuedAt >= Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Steward credential issue time is invalid");
    }
    const credentialNotBefore =
      credentialIssuedAt === undefined ? 0 : credentialIssuedAt + 1;
    const updated = await dbWrite.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!locked?.organization_id) {
        throw new Error(`User ${userId} has no inference authorization identity`);
      }
      const nextNotBefore = Math.max(
        locked.inference_session_not_before,
        Math.floor(Date.now() / 1_000) + 1,
        credentialNotBefore,
      );
      const [revisioned] = await tx
        .update(users)
        .set({
          inference_session_not_before: nextNotBefore,
          updated_at: new Date(),
        })
        .where(eq(users.id, userId))
        .returning();
      if (!revisioned) {
        throw new Error(`User ${userId} disappeared during session revocation`);
      }
      await applyInferenceAuthorizationState(
        locked.organization_id,
        stewardSessionAuthorizationState(revisioned),
      );
      return revisioned;
    });
    await this.invalidateCache(updated);
    return updated;
  }

  async invalidateCache(user: User | UserWithOrganization): Promise<void> {
    const promises: Promise<void>[] = [
      cache.del(CacheKeys.user.byId(user.id)),
      cache.del(CacheKeys.user.withOrg(user.id)),
    ];
    if (user.email) {
      promises.push(cache.del(CacheKeys.user.byEmail(user.email)));
      promises.push(cache.del(CacheKeys.user.byEmailWithOrg(user.email)));
    }
    const stewardUserId = user.steward_user_id;
    if (typeof stewardUserId === "string") {
      promises.push(cache.del(CacheKeys.user.byStewardId(stewardUserId)));
      promises.push(cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)));
    }
    const walletAddress = user.wallet_address;
    if (typeof walletAddress === "string") {
      promises.push(cache.del(CacheKeys.user.byWalletAddress(walletAddress)));
      promises.push(cache.del(CacheKeys.user.byWalletAddressWithOrg(walletAddress)));
    }
    await Promise.all(promises);
    logger.debug("[UsersService] Invalidated cache for user:", user.id);
  }

  async getById(id: string): Promise<User | undefined> {
    const cacheKey = CacheKeys.user.byId(id);
    const cached = await cache.get<User>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byId:", id);
      return cached;
    }
    const user = await usersRepository.findById(id);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byId);
      logger.debug("[UsersService] Cached user data:", id);
    }
    return user;
  }

  async getByEmail(email: string): Promise<User | undefined> {
    const cacheKey = CacheKeys.user.byEmail(email);
    const cached = await cache.get<User>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byEmail");
      return cached;
    }
    const user = await usersRepository.findByEmail(email);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byEmail);
      logger.debug("[UsersService] Cached user data by email");
    }
    return user;
  }

  async getByStewardId(stewardUserId: string): Promise<UserWithOrganization | undefined> {
    const cacheKey = CacheKeys.user.byStewardId(stewardUserId);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byStewardId");
      return cached;
    }

    try {
      // Auth hot path: this resolves on every authenticated request. A transient
      // DB connection blip (a Worker→Hyperdrive connection terminated mid-query,
      // an SSL-handshake EOF under load) must not turn a valid session into a
      // 500 — retry transient connection failures with bounded backoff before
      // surfacing. Non-transient errors are not retried.
      const user = await retryOnTransientDbError(
        () => usersRepository.findByStewardIdWithOrganization(stewardUserId),
        { attempts: 3 },
      );
      if (user) {
        await cache.set(cacheKey, user, CacheTTL.user.byStewardId);
        logger.debug("[UsersService] Cached user data by stewardId");
      }
      return user;
    } catch (error) {
      // error-policy:J2 auth hot path — read-replica lookup failed; add context and
      // fail over to the primary. Never fabricates a user; rethrows via the inner catch.
      const errorDetails = getErrorDetails(error);

      logger.warn("[UsersService] Read-path Steward lookup failed, retrying on primary", {
        stewardUserId,
        ...errorDetails,
      });

      try {
        return await retryOnTransientDbError(() => this.getByStewardIdForWrite(stewardUserId), {
          attempts: 2,
        });
      } catch (fallbackError) {
        // error-policy:J2 both replica and primary failed — record combined context and
        // rethrow the primary error (its cause chain is preserved) so the caller 500s.
        logger.error("[UsersService] Primary Steward lookup retry failed", {
          stewardUserId,
          readError: errorDetails,
          writeError: getErrorDetails(fallbackError),
        });
        throw fallbackError;
      }
    }
  }

  async getByStewardIdForWrite(stewardUserId: string): Promise<UserWithOrganization | undefined> {
    const user = await usersRepository.findByStewardIdWithOrganizationForWrite(stewardUserId);
    if (user) {
      await Promise.all([
        cache.set(CacheKeys.user.byStewardId(stewardUserId), user, CacheTTL.user.byStewardId),
        cache.set(
          CacheKeys.user.byStewardIdWithOrg(stewardUserId),
          user,
          CacheTTL.user.byStewardIdWithOrg,
        ),
      ]);
      logger.debug("[UsersService] Cached user data by stewardId from primary");
    }
    return user;
  }

  async getStewardIdentityForWrite(
    stewardUserId: string,
  ): Promise<{ user_id: string; steward_user_id: string } | undefined> {
    return await usersRepository.findIdentityByStewardIdForWrite(stewardUserId);
  }

  async getWithOrganization(userId: string): Promise<UserWithOrganization | undefined> {
    const cacheKey = CacheKeys.user.withOrg(userId);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user withOrg:", userId);
      return cached;
    }
    const user = await usersRepository.findWithOrganization(userId);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.withOrg);
      logger.debug("[UsersService] Cached user withOrg data:", userId);
    }
    return user;
  }

  async getByEmailWithOrganization(email: string): Promise<UserWithOrganization | undefined> {
    const cacheKey = CacheKeys.user.byEmailWithOrg(email);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byEmailWithOrg");
      return cached;
    }
    const user = await usersRepository.findByEmailWithOrganization(email);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byEmailWithOrg);
      logger.debug("[UsersService] Cached user data byEmailWithOrg");
    }
    return user;
  }

  async getByWalletAddress(walletAddress: string): Promise<User | undefined> {
    const cacheKey = CacheKeys.user.byWalletAddress(walletAddress);
    const cached = await cache.get<User>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byWalletAddress");
      return cached;
    }
    const user = await usersRepository.findByWalletAddress(walletAddress);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byWalletAddress);
      logger.debug("[UsersService] Cached user data byWalletAddress");
    }
    return user;
  }

  async getByWalletAddressWithOrganization(
    walletAddress: string,
  ): Promise<UserWithOrganization | undefined> {
    const cacheKey = CacheKeys.user.byWalletAddressWithOrg(walletAddress);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byWalletAddressWithOrg");
      return cached;
    }
    const user = await usersRepository.findByWalletAddressWithOrganization(walletAddress);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byWalletAddressWithOrg);
      logger.debug("[UsersService] Cached user data byWalletAddressWithOrg");
    }
    return user;
  }

  async listByOrganization(organizationId: string): Promise<User[]> {
    return await usersRepository.listByOrganization(organizationId);
  }

  async create(data: NewUser): Promise<User> {
    const user = await usersRepository.create(data);
    await this.invalidateCache(user);
    return user;
  }

  /**
   * Inference hot path (#9981 review gap): drop every cached IAC identity for a
   * user's API keys after the strongly ordered lifecycle transition. This is
   * retry hygiene: the admission object rejects stale grants even if replicated
   * cache deletion fails. Mirrors the ban/suspend wiring already in admin.ts.
   */
  private async invalidateInferenceAuthForUser(userId: string): Promise<void> {
    try {
      const keys = await apiKeysRepository.listByUser(userId);
      await invalidateInferenceAuthContextsByKeyHashes(keys.map((k) => k.key_hash));
    } catch (error) {
      // error-policy:J6 best-effort IAC cache eviction — a cache blip must not break the
      // lifecycle write (deactivate/detach/delete). The slow path still enforces is_active.
      logger.warn("[UsersService] Failed to invalidate inference auth cache for user", {
        userId,
        ...getErrorDetails(error),
      });
    }
  }

  async update(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    const changesAuthorization =
      Object.hasOwn(data, "is_active") ||
      Object.hasOwn(data, "organization_id") ||
      Object.hasOwn(data, "deleted_at") ||
      Object.hasOwn(data, "steward_user_id");
    let existing: User | undefined;
    let result: User | undefined;
    let authorizationAppliedBeforeCommit = false;
    let movedOrganization = false;
    if (!changesAuthorization) {
      existing = await usersRepository.findById(id);
      result = await usersRepository.update(id, data);
    } else {
      const transition = await dbWrite.transaction(async (tx) => {
        const [locked] = await tx.select().from(users).where(eq(users.id, id)).for("update");
        if (!locked) {
          return {
            existing: undefined,
            updated: undefined,
            authorizationApplied: false,
            moved: false,
          };
        }
        const [updated] = await tx
          .update(users)
          .set({
            ...data,
            inference_auth_revision: sql`${users.inference_auth_revision} + 1`,
            updated_at: new Date(),
          })
          .where(eq(users.id, id))
          .returning();
        if (!updated) {
          throw new Error(`User ${id} disappeared during update`);
        }
        const moved = locked.organization_id !== updated.organization_id;
        const denied = !updated.is_active || updated.deleted_at !== null;
        const identityChanged = locked.steward_user_id !== updated.steward_user_id;
        const authorizationApplied = moved || denied || identityChanged;
        if (authorizationApplied && locked.organization_id) {
          await applyInferenceAuthorizationState(
            locked.organization_id,
            userAuthorizationState(updated, moved || denied),
          );
        }
        return { existing: locked, updated, authorizationApplied, moved };
      });
      existing = transition.existing;
      result = transition.updated;
      authorizationAppliedBeforeCommit = transition.authorizationApplied;
      movedOrganization = transition.moved;
      if (
        result?.organization_id &&
        (!authorizationAppliedBeforeCommit || movedOrganization)
      ) {
        await applyInferenceAuthorizationState(
          result.organization_id,
          userAuthorizationState(result),
        );
      }
    }
    if (existing) {
      await this.invalidateCache(existing);
    }
    if (result) {
      await this.invalidateCache(result);
    }
    // Eviction keeps later requests from carrying a stale proof to the boundary.
    if (data.is_active === false) {
      await this.invalidateInferenceAuthForUser(id);
    }
    return result;
  }

  async upsertStewardIdentity(userId: string, stewardUserId: string): Promise<void> {
    const existingIdentity = await usersRepository.findIdentityByUserIdForWrite(userId);
    const existingUser = await usersRepository.findWithOrganizationForWrite(userId);
    if (!existingUser) {
      throw new Error(`User ${userId} not found while upserting Steward identity`);
    }

    if (
      existingIdentity?.steward_user_id === stewardUserId &&
      existingUser.steward_user_id === stewardUserId
    ) {
      await Promise.all([
        cache.del(CacheKeys.user.byStewardId(stewardUserId)),
        cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)),
      ]);
      return;
    }

    if (existingUser.steward_user_id !== stewardUserId) {
      const updated = await this.update(userId, { steward_user_id: stewardUserId });
      if (!updated) {
        throw new Error(`User ${userId} disappeared while upserting Steward identity`);
      }
    }
    await usersRepository.upsertStewardIdentity(userId, stewardUserId);

    const cacheDeletes = [
      cache.del(CacheKeys.user.byStewardId(stewardUserId)),
      cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)),
    ];

    if (existingIdentity?.steward_user_id && existingIdentity.steward_user_id !== stewardUserId) {
      cacheDeletes.push(
        cache.del(CacheKeys.user.byStewardId(existingIdentity.steward_user_id)),
        cache.del(CacheKeys.user.byStewardIdWithOrg(existingIdentity.steward_user_id)),
      );
    }

    await Promise.all(cacheDeletes);
  }

  async linkStewardId(userId: string, stewardUserId: string): Promise<void> {
    const existing = await usersRepository.findById(userId);
    const updated = await this.update(userId, { steward_user_id: stewardUserId });
    if (!updated) {
      throw new Error(`User ${userId} not found while linking Steward identity`);
    }
    await usersRepository.upsertStewardIdentity(userId, stewardUserId);

    if (existing) {
      await this.invalidateCache(existing);
    }
    if (updated) {
      await this.invalidateCache(updated);
    }

    await Promise.all([
      cache.del(CacheKeys.user.byStewardId(stewardUserId)),
      cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)),
    ]);
  }

  /**
   * Detach a user from their current organization WITHOUT deleting the account
   * (#11332): removing an org member must not destroy their identity. The
   * removed user is moved to a fresh personal organization where they are
   * owner — the same shape signup auto-creates — and their API keys scoped to
   * the old organization are deactivated (those keys authenticate AS the old
   * org; a removed member must not keep spending its credits). The new org
   * starts at $0: detach is not signup, so no welcome credits — an
   * invite→remove cycle must not mint free credit.
   */
  async detachFromOrganization(id: string): Promise<User> {
    const user = await usersRepository.findById(id);
    if (!user) {
      throw new Error(`User ${id} not found`);
    }

    let slug = generatePersonalOrgSlug(user);
    let attempts = 0;
    while (await organizationsRepository.findBySlug(slug)) {
      attempts++;
      if (attempts > 10) {
        throw new Error(`Failed to generate unique organization slug for user ${id}`);
      }
      slug = generatePersonalOrgSlug(user);
    }

    const organization = await organizationsRepository.create({
      name: `${user.name || user.email || "User"}'s Organization`,
      slug,
      credit_balance: "0.00",
    });

    let updated: User | undefined;
    try {
      updated = await this.update(id, {
        organization_id: organization.id,
        role: "owner",
      });
      if (!updated) {
        throw new Error(`Failed to move user ${id} to personal organization ${organization.id}`);
      }
    } catch (error) {
      // Don't strand an empty org when the move fails.
      try {
        const { organizationsService } = await import("./organizations");
        await organizationsService.delete(organization.id);
      } catch (rollbackError) {
        // error-policy:J6 best-effort rollback of the just-created empty org; log and
        // fall through to rethrow the original move failure (never masks it).
        logger.error("[UsersService] Failed to roll back personal org after detach failure", {
          userId: id,
          organizationId: organization.id,
          ...getErrorDetails(rollbackError),
        });
      }
      throw error;
    }

    if (user.organization_id) {
      const { apiKeysService } = await import("./api-keys");
      await apiKeysService.deactivateByUserAndOrganization(id, user.organization_id);
    }

    await this.invalidateCache(user);
    await this.invalidateCache(updated);
    // Evict projections for the revoked old-organization credentials.
    await this.invalidateInferenceAuthForUser(id);

    return updated;
  }

  async delete(id: string): Promise<void> {
    const user = await this.getById(id);

    if (!user) {
      throw new Error(`User ${id} not found`);
    }

    await this.invalidateCache(user);
    // Resolve + evict the user's cached IAC identities BEFORE the row is deleted:
    // at delete time the user is still active, so an is_active gate can't fire and
    // the key_hash set must be read while the keys still exist.
    await this.invalidateInferenceAuthForUser(id);
    const organizationId = await dbWrite.transaction(async (tx) => {
      const [locked] = await tx.select().from(users).where(eq(users.id, id)).for("update");
      if (!locked) {
        throw new Error(`User ${id} not found`);
      }
      const [restricted] = await tx
        .update(users)
        .set({
          is_active: false,
          deleted_at: new Date(),
          inference_auth_revision: sql`${users.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(eq(users.id, id))
        .returning();
      if (!restricted) {
        throw new Error(`User ${id} disappeared during deletion`);
      }
      if (restricted.organization_id) {
        await applyInferenceAuthorizationState(
          restricted.organization_id,
          userAuthorizationState(restricted, true),
        );
      }
      await tx.delete(users).where(eq(users.id, id));
      return locked.organization_id;
    });

    // Check if this was the last user in the organization
    if (organizationId) {
      const remainingUsers = await usersRepository.listByOrganization(organizationId);

      // If no users remain, delete the organization
      if (remainingUsers.length === 0) {
        const { organizationsService } = await import("./organizations");
        await organizationsService.delete(organizationId);
      }
    }
  }
}

// Export singleton instance
export const usersService = new UsersService();
