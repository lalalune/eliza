/**
 * Cache-only Steward session authorization for model-inference routes.
 *
 * Every request still verifies the signed JWT locally, using only isolate
 * memory and local cryptography. Cloud user, organization, and
 * moderation state are consumed only from a combined cache decision. A cold
 * Worker request returns a retryable warming result while authoritative
 * hydration runs under `waitUntil`, so Postgres never joins model dispatch.
 *
 * Cache READS and WRITES are both gated on `useAuthCache`
 * (`INFERENCE_AUTH_CACHE_ENABLED`): while the flag is off, the origin path
 * neither consults nor populates the session decision cache, mirroring the
 * API-key path in `inference-auth-context.ts`. A disabled authorization cache
 * must leave no positive identities behind in KV.
 */

import { AuthenticationError, ForbiddenError } from "../api/cloud-worker-errors";
import { verifyStewardTokenCached } from "../auth/steward-client";
import { readStewardAccessCookieFromHeader, stewardCookieNames } from "../auth/steward-cookies";
import { cache } from "../cache/client";
import { getCookieValueFromHeader } from "../http/cookie-header";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import {
  hashInferenceSessionCredential,
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceSessionAuthContext,
  type InferenceSessionAuthDecision,
  readInferenceSessionAuthDecision,
  writeInferenceSessionAuthDecision,
} from "./inference-auth-cache";
import {
  applyInferenceAuthorizationStates,
  INFERENCE_AUTHORIZATION_BOUNDARY_VERSION,
  initializeInferenceAuthorizationBoundary,
} from "./inference-authorization-boundary";
import {
  moderationAuthorizationState,
  organizationAuthorizationState,
  stewardSessionAuthorizationState,
  userAuthorizationState,
} from "./inference-authorization-lifecycle";
import { usersService } from "./users";

const sessionHydrations = new Map<string, Promise<InferenceSessionAuthDecision>>();

export interface ResolveInferenceSessionAuthOptions {
  cacheOnly?: boolean;
  useAuthCache?: boolean;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

export type InferenceSessionAuthResolution =
  | { kind: "not_session" }
  | {
      kind: "authorized";
      ctx: InferenceSessionAuthContext;
      source: "cache" | "origin";
    }
  | { kind: "suspended"; userId?: string }
  | { kind: "rejected"; status: 401 | 403 }
  | { kind: "warming" };

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export interface ExtractInferenceSessionCredentialOptions {
  /**
   * Mutation boundaries such as logout may only act on the cookie namespace
   * owned by their environment. Inference reads retain the bounded legacy
   * fallback so existing non-production sessions can finish their migration.
   */
  environmentOwnedCookieOnly?: boolean;
  environment?: string;
}

/**
 * Extract a Steward bearer or cookie credential with inference auth precedence.
 *
 * An explicit API-key bearer owns the request and never falls through to a
 * Steward cookie. JWT bearers win over cookies. Non-JWT bearer values permit a
 * cookie fallback because they are not inference credentials.
 */
export function extractInferenceSessionCredential(
  req: Request,
  options: ExtractInferenceSessionCredentialOptions = {},
): string | null {
  const authorization = req.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  if (bearer?.startsWith("eliza_")) return null;
  if (bearer && looksLikeJwt(bearer)) return bearer;

  const environment = options.environment ?? getCloudAwareEnv().ENVIRONMENT;
  const cookieHeader = req.headers.get("cookie");
  if (options.environmentOwnedCookieOnly) {
    const names = stewardCookieNames(environment);
    return getCookieValueFromHeader(cookieHeader, names.token) ?? null;
  }
  return readStewardAccessCookieFromHeader(cookieHeader, environment) ?? null;
}

function rejection(
  stewardUserId: string,
  credentialFingerprint: string,
  status: 401 | 403,
): InferenceSessionAuthDecision {
  return {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    stewardUserId,
    credentialFingerprint,
    decision: "rejected",
    status,
  };
}

async function hydrateAuthoritativeDecision(params: {
  stewardUserId: string;
  credentialFingerprint: string;
  credentialExpiresAt: number;
  credentialIssuedAt: number;
  email?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
}): Promise<InferenceSessionAuthDecision> {
  let user = await usersService.getByStewardIdForWrite(params.stewardUserId);
  if (!user) {
    const { syncUserFromSteward } = await import("../steward-sync");
    user = await syncUserFromSteward({
      stewardUserId: params.stewardUserId,
      email: params.email,
      walletAddress: params.walletAddress,
      walletChainType: params.walletChain,
    });
  }
  if (!user) {
    return rejection(params.stewardUserId, params.credentialFingerprint, 401);
  }
  if (!user.is_active) {
    return rejection(params.stewardUserId, params.credentialFingerprint, 403);
  }
  if (!user.organization_id || !user.organization) {
    return rejection(params.stewardUserId, params.credentialFingerprint, 403);
  }
  if (!user.organization.is_active) {
    return rejection(params.stewardUserId, params.credentialFingerprint, 403);
  }
  if (params.credentialIssuedAt < user.inference_session_not_before) {
    return rejection(params.stewardUserId, params.credentialFingerprint, 401);
  }
  if (await adminService.shouldBlockUser(user.id)) {
    return {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      stewardUserId: params.stewardUserId,
      credentialFingerprint: params.credentialFingerprint,
      decision: "suspended",
      status: 403,
    };
  }
  const decision: InferenceSessionAuthContext = {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    userId: user.id,
    orgId: user.organization_id,
    apiKeyId: null,
    stewardUserId: params.stewardUserId,
    authorization: {
      v: INFERENCE_AUTHORIZATION_BOUNDARY_VERSION,
      organizationId: user.organization_id,
      organizationRevision: String(user.organization.inference_auth_revision),
      userId: user.id,
      userRevision: String(user.inference_auth_revision),
      credential: {
        kind: "steward_session",
        id: params.credentialFingerprint,
        fingerprint: params.credentialFingerprint,
        revision: String(params.credentialIssuedAt),
        expiresAt: params.credentialExpiresAt,
      },
    },
  };
  await initializeInferenceAuthorizationBoundary(user.organization_id);
  await applyInferenceAuthorizationStates(user.organization_id, [
    organizationAuthorizationState(user.organization),
    userAuthorizationState(user),
    moderationAuthorizationState(user, false),
    stewardSessionAuthorizationState(user),
  ]);
  return decision;
}

function toResolution(
  decision: InferenceSessionAuthDecision,
  source: "cache" | "origin",
): InferenceSessionAuthResolution {
  if ("apiKeyId" in decision) {
    return { kind: "authorized", ctx: decision, source };
  }
  if (decision.decision === "suspended") {
    return { kind: "suspended" };
  }
  return { kind: "rejected", status: decision.status };
}

async function hydrateAndCache(
  params: {
    stewardUserId: string;
    credentialFingerprint: string;
    credentialExpiresAt: number;
    credentialIssuedAt: number;
    email?: string;
    walletAddress?: string;
    walletChain?: "ethereum" | "solana";
  },
  persistDecision: boolean,
): Promise<InferenceSessionAuthDecision> {
  const decision = await hydrateAuthoritativeDecision(params);
  if (persistDecision) await writeInferenceSessionAuthDecision(decision);
  return decision;
}

// A credential-specific key prevents one revoked session from sharing a
// hydration or cache decision with another session for the same user.
function getOrCreateHydration(
  params: {
    stewardUserId: string;
    credentialFingerprint: string;
    credentialExpiresAt: number;
    credentialIssuedAt: number;
    email?: string;
    walletAddress?: string;
    walletChain?: "ethereum" | "solana";
  },
  persistDecision: boolean,
): Promise<InferenceSessionAuthDecision> {
  const existing = sessionHydrations.get(params.credentialFingerprint);
  if (existing) return existing;

  const hydration = hydrateAndCache(params, persistDecision);
  sessionHydrations.set(params.credentialFingerprint, hydration);
  const clear = () => {
    if (sessionHydrations.get(params.credentialFingerprint) === hydration) {
      sessionHydrations.delete(params.credentialFingerprint);
    }
  };
  hydration.then(clear, clear);
  return hydration;
}

/** Test hook for isolating coalesced background hydrations. */
export function __clearInferenceSessionAuthHydrations(): void {
  sessionHydrations.clear();
}

/**
 * Resolve a Steward session without allowing authoritative work onto a Worker
 * request promise. `cacheOnly` callers either receive a verified cache decision
 * or a warming result; there is no database fallback.
 */
export async function resolveInferenceSessionAuthContext(
  req: Request,
  options: ResolveInferenceSessionAuthOptions = {},
): Promise<InferenceSessionAuthResolution> {
  const token = extractInferenceSessionCredential(req);
  if (!token) return { kind: "not_session" };

  const env = getCloudAwareEnv();
  const claims = await verifyStewardTokenCached(
    {
      STEWARD_SESSION_SECRET: env.STEWARD_SESSION_SECRET,
      STEWARD_JWT_SECRET: env.STEWARD_JWT_SECRET,
      STEWARD_TENANT_ID: env.STEWARD_TENANT_ID,
    },
    token,
    { executionCtx: options.executionCtx, localOnly: true },
  );
  if (!claims) return { kind: "rejected", status: 401 };
  const credentialFingerprint = hashInferenceSessionCredential(token);
  const credentialExpiresAt = claims.expiration * 1_000;

  if (options.useAuthCache && cache.isAvailable()) {
    const cached = await readInferenceSessionAuthDecision(credentialFingerprint).catch((error) => {
      // error-policy:J4 inference remains explicitly unavailable on a cache
      // failure; never fall through to an inline database authorization.
      logger.warn("[InferenceSessionAuth] Cache read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (cached) return toResolution(cached, "cache");
  }

  if (options.useAuthCache && options.cacheOnly) {
    if (cache.isAvailable() && options.executionCtx) {
      const hydration = getOrCreateHydration(
        {
          stewardUserId: claims.userId,
          credentialFingerprint,
          credentialExpiresAt,
          credentialIssuedAt: claims.issuedAt,
          email: claims.email,
          walletAddress: claims.walletAddress,
          walletChain: claims.walletChain,
        },
        true,
      )
        .then(() => undefined)
        .catch((error) => {
          // error-policy:J7 authoritative hydration is observed by waitUntil;
          // the current request already returned an explicit warming state.
          logger.warn("[InferenceSessionAuth] Background hydration failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      options.executionCtx.waitUntil(hydration);
    }
    return { kind: "warming" };
  }

  // Origin path: persist the decision only when the auth cache is enabled —
  // a disabled cache must not be pre-populated with positive identities
  // (mirrors the API-key path's flag-gated positive write).
  const decision = await getOrCreateHydration(
    {
      stewardUserId: claims.userId,
      credentialFingerprint,
      credentialExpiresAt,
      credentialIssuedAt: claims.issuedAt,
      email: claims.email,
      walletAddress: claims.walletAddress,
      walletChain: claims.walletChain,
    },
    options.useAuthCache === true,
  );
  const resolved = toResolution(decision, "origin");
  if (resolved.kind === "rejected") {
    if (resolved.status === 401) throw AuthenticationError();
    throw ForbiddenError();
  }
  return resolved;
}
