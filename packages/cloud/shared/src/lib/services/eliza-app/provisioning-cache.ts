/**
 * Cache projection for provisioning state consumed by interactive LLM routes.
 *
 * Authoritative sandbox queries, starter-credit grants, and provisioning
 * commands run only under waitUntil. A cold projection is an explicit warming
 * result; it never fabricates an empty sandbox state on the provider path.
 */

import { cache } from "../../cache/client";
import { logger } from "../../utils/logger";
import {
  type ElizaAppProvisioningStatus,
  ensureElizaAppProvisioning,
  getElizaAppProvisioningStatus,
} from "./provisioning";

const CACHE_VERSION = 1 as const;
const CACHE_TTL_SECONDS = 5 * 60;
const REFRESH_AFTER_MS = 10_000;
const refreshFlights = new Map<string, Promise<void>>();

interface CachedProvisioningStatus {
  v: typeof CACHE_VERSION;
  cachedAt: number;
  organizationId: string;
  status: string;
  agentId: string | null;
  bridgeUrl: string | null;
}

export interface ProvisioningCacheExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type ProvisioningCacheResolution =
  | { kind: "ready"; status: ElizaAppProvisioningStatus }
  | { kind: "warming" };

function key(organizationId: string): string {
  return `eliza-app:provisioning:${organizationId}:v1`;
}

function validCachedStatus(
  value: unknown,
  organizationId: string,
): value is CachedProvisioningStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return (
    status.v === CACHE_VERSION &&
    status.organizationId === organizationId &&
    typeof status.cachedAt === "number" &&
    Number.isFinite(status.cachedAt) &&
    typeof status.status === "string" &&
    status.status.length > 0 &&
    (status.agentId === null || typeof status.agentId === "string") &&
    (status.bridgeUrl === null || typeof status.bridgeUrl === "string")
  );
}

function toPublicStatus(status: CachedProvisioningStatus): ElizaAppProvisioningStatus {
  return {
    status: status.status,
    agentId: status.agentId,
    bridgeUrl: status.bridgeUrl,
    sandbox: null,
  };
}

async function refresh(params: {
  organizationId: string;
  userId?: string;
  ensure: boolean;
}): Promise<void> {
  const authoritative =
    params.ensure && params.userId
      ? await ensureElizaAppProvisioning({
          organizationId: params.organizationId,
          userId: params.userId,
        })
      : await getElizaAppProvisioningStatus(params.organizationId);
  const projection: CachedProvisioningStatus = {
    v: CACHE_VERSION,
    cachedAt: Date.now(),
    organizationId: params.organizationId,
    status: authoritative.status,
    agentId: authoritative.agentId,
    bridgeUrl: authoritative.bridgeUrl,
  };
  const outcome = await cache.setWithOutcome(
    key(params.organizationId),
    projection,
    CACHE_TTL_SECONDS,
  );
  if (outcome.kind !== "written") {
    throw new Error(`Eliza App provisioning cache write failed: ${outcome.kind}`);
  }
}

function scheduleRefresh(
  params: {
    organizationId: string;
    userId?: string;
    ensure: boolean;
  },
  executionCtx: ProvisioningCacheExecutionContext,
): void {
  const flightKey = `${params.organizationId}:${params.ensure ? "ensure" : "read"}`;
  let task = refreshFlights.get(flightKey);
  if (!task) {
    const current = refresh(params).finally(() => {
      if (refreshFlights.get(flightKey) === current) {
        refreshFlights.delete(flightKey);
      }
    });
    task = current;
    refreshFlights.set(flightKey, current);
  }
  executionCtx.waitUntil(
    task.catch((error) => {
      // error-policy:J7 the request returns a warming or stale status while
      // the failed control-plane refresh stays visible and retryable.
      logger.error("[ElizaAppProvisioningCache] Background refresh failed", {
        organizationId: params.organizationId,
        ensure: params.ensure,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

/**
 * Resolve provisioning state without allowing the authoritative query to join
 * the caller's promise.
 */
export async function resolveElizaAppProvisioningCache(params: {
  organizationId: string;
  userId?: string;
  ensure: boolean;
  executionCtx: ProvisioningCacheExecutionContext;
}): Promise<ProvisioningCacheResolution> {
  const outcome = await cache.getWithOutcome<unknown>(key(params.organizationId));
  if (outcome.kind === "hit" && validCachedStatus(outcome.value, params.organizationId)) {
    if (params.ensure || Date.now() - outcome.value.cachedAt >= REFRESH_AFTER_MS) {
      scheduleRefresh(params, params.executionCtx);
    }
    return { kind: "ready", status: toPublicStatus(outcome.value) };
  }
  if (outcome.kind === "hit") {
    await cache.del(key(params.organizationId));
  }
  scheduleRefresh(params, params.executionCtx);
  return { kind: "warming" };
}

/** Test hook for isolating refresh coalescing. */
export function __clearElizaAppProvisioningRefreshes(): void {
  refreshFlights.clear();
}
