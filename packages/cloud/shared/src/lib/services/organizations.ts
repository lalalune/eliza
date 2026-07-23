/**
 * Organizations service for managing organization data and credit balances.
 */

import { eq, sql } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import {
  apiKeysRepository,
  type NewOrganization,
  type Organization,
  organizationsRepository,
} from "../../db/repositories";
import { organizations } from "../../db/schemas/organizations";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { invalidateInferenceAuthContextsByKeyHashes } from "./inference-auth-cache";
import { applyInferenceAuthorizationState } from "./inference-authorization-boundary";
import { organizationAuthorizationState } from "./inference-authorization-lifecycle";

/**
 * Service for organization operations with caching support.
 */
export class OrganizationsService {
  /**
   * Get organization by ID with full caching.
   * Caches the entire organization object to avoid redundant DB calls.
   */
  async getById(id: string): Promise<Organization | undefined> {
    const cacheKey = CacheKeys.org.data(id);

    // Try cache first - return immediately on hit (no DB call!)
    const cached = await cache.get<Organization>(cacheKey);
    if (cached) {
      logger.debug("[OrganizationsService] Cache hit for org:", id);
      return cached;
    }

    // Cache miss - fetch from DB
    const org = await organizationsRepository.findById(id);

    if (org) {
      // Cache the full organization object
      await cache.set(cacheKey, org, CacheTTL.org.data);
      logger.debug("[OrganizationsService] Cached org data:", id);
    }

    return org;
  }

  /**
   * Invalidate organization cache (call after updates)
   */
  async invalidateCache(id: string): Promise<void> {
    const cacheKey = CacheKeys.org.data(id);
    await cache.del(cacheKey);
    // Also invalidate the old balance-only cache key for backwards compat
    await cache.del(CacheKeys.eliza.orgBalance(id));
    logger.debug("[OrganizationsService] Invalidated cache for org:", id);
  }

  async getBySlug(slug: string): Promise<Organization | undefined> {
    return await organizationsRepository.findBySlug(slug);
  }

  async getByStripeCustomerId(stripeCustomerId: string): Promise<Organization | undefined> {
    return await organizationsRepository.findByStripeCustomerId(stripeCustomerId);
  }

  async getWithUsers(id: string) {
    return await organizationsRepository.findWithUsers(id);
  }

  async create(data: NewOrganization): Promise<Organization> {
    return await organizationsRepository.create(data);
  }

  /**
   * Inference hot path (#9981 review gap): drop every cached IAC identity for an
   * org's API keys after the strongly ordered lifecycle transition. This keeps
   * stale projections from causing avoidable rejected retries; the admission
   * object remains authoritative if cache deletion fails.
   */
  private async invalidateInferenceAuthForOrganization(organizationId: string): Promise<void> {
    try {
      const keys = await apiKeysRepository.listByOrganization(organizationId);
      await invalidateInferenceAuthContextsByKeyHashes(keys.map((k) => k.key_hash));
    } catch (error) {
      logger.warn("[OrganizationsService] Failed to invalidate inference auth cache for org", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async update(id: string, data: Partial<NewOrganization>): Promise<Organization | undefined> {
    let result: Organization | undefined;
    if (data.is_active === undefined) {
      result = await organizationsRepository.update(id, data);
    } else {
      result = await dbWrite.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, id))
          .for("update");
        if (!existing) return undefined;
        const [updated] = await tx
          .update(organizations)
          .set({
            ...data,
            inference_auth_revision: sql`${organizations.inference_auth_revision} + 1`,
            updated_at: new Date(),
          })
          .where(eq(organizations.id, id))
          .returning();
        if (!updated) return undefined;
        if (!updated.is_active) {
          await applyInferenceAuthorizationState(
            updated.id,
            organizationAuthorizationState(updated),
          );
        }
        return updated;
      });
      if (result?.is_active) {
        await applyInferenceAuthorizationState(result.id, organizationAuthorizationState(result));
      }
    }
    // Invalidate cache after update
    await this.invalidateCache(id);
    // Eviction keeps later requests from carrying stale proofs to the boundary.
    if (data.is_active === false) {
      await this.invalidateInferenceAuthForOrganization(id);
    }
    return result;
  }

  async updateCreditBalance(
    organizationId: string,
    amount: number,
  ): Promise<{ success: boolean; newBalance: number }> {
    const result = await organizationsRepository.updateCreditBalance(organizationId, amount);
    // Invalidate cache after balance change
    await this.invalidateCache(organizationId);
    return result;
  }

  async delete(id: string): Promise<void> {
    // Resolve + evict the org's cached IAC identities BEFORE the delete cascade
    // removes the api_keys rows, so the key_hash set is read while it still exists.
    await this.invalidateInferenceAuthForOrganization(id);
    await dbWrite.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .for("update");
      if (!existing) return;
      const [restricted] = await tx
        .update(organizations)
        .set({
          is_active: false,
          inference_auth_revision: sql`${organizations.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(eq(organizations.id, id))
        .returning();
      if (!restricted) {
        throw new Error(`Organization ${id} disappeared during deletion`);
      }
      await applyInferenceAuthorizationState(id, organizationAuthorizationState(restricted));
      await tx.delete(organizations).where(eq(organizations.id, id));
    });
    // Invalidate cache after delete
    await this.invalidateCache(id);
  }
}

// Export singleton instance
export const organizationsService = new OrganizationsService();

// Re-export types for convenience
export type { NewOrganization, Organization } from "../../db/repositories";
