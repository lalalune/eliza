/**
 * Cache-only strong authorization for signed Eliza App inference sessions.
 *
 * JWT signature and expiry checks are local. A cold credential schedules
 * primary user, organization, moderation, and session-state hydration under
 * waitUntil and returns a warming decision, so Postgres never joins the
 * provider request promise. The organization Durable Object rechecks the
 * resulting proof immediately before dispatch.
 */

import { createHash } from "node:crypto";
import { usersRepository } from "../../../db/repositories";
import { cache } from "../../cache/client";
import { CacheKeys, CacheTTL } from "../../cache/keys";
import { logger } from "../../utils/logger";
import { adminService } from "../admin";
import type { InferenceAuthorizationProof } from "../inference-authorization-boundary";
import {
  applyInferenceAuthorizationStates,
  INFERENCE_AUTHORIZATION_BOUNDARY_VERSION,
  initializeInferenceAuthorizationBoundary,
} from "../inference-authorization-boundary";
import {
  moderationAuthorizationState,
  organizationAuthorizationState,
  stewardSessionAuthorizationState,
  userAuthorizationState,
} from "../inference-authorization-lifecycle";
import { elizaAppSessionService, type ValidatedSession } from "./session-service";

const DECISION_VERSION = 1 as const;
const hydrationFlights = new Map<string, Promise<void>>();

export interface ElizaAppInferenceIdentity {
  userId: string;
  organizationId: string;
  authorization: InferenceAuthorizationProof;
}

interface CachedAuthorizedDecision extends ElizaAppInferenceIdentity {
  v: typeof DECISION_VERSION;
  cachedAt: number;
  decision: "authorized";
  credentialFingerprint: string;
}

interface CachedRejectedDecision {
  v: typeof DECISION_VERSION;
  cachedAt: number;
  decision: "rejected" | "suspended";
  status: 401 | 403;
  credentialFingerprint: string;
}

type CachedDecision = CachedAuthorizedDecision | CachedRejectedDecision;

export type ElizaAppInferenceAuthResolution =
  | { kind: "authorized"; identity: ElizaAppInferenceIdentity }
  | { kind: "not_app_session" }
  | { kind: "rejected"; status: 401 | 403 }
  | { kind: "warming" };

export interface ElizaAppInferenceExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function credentialFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.split(".").length === 3 ? token : null;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
}

function isCachedDecision(
  value: unknown,
  fingerprint: string,
  session: ValidatedSession,
): value is CachedDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Record<string, unknown>;
  if (
    decision.v !== DECISION_VERSION ||
    typeof decision.cachedAt !== "number" ||
    !Number.isFinite(decision.cachedAt) ||
    decision.credentialFingerprint !== fingerprint
  ) {
    return false;
  }
  if (decision.decision === "rejected" || decision.decision === "suspended") {
    return decision.status === 401 || decision.status === 403;
  }
  if (
    decision.decision !== "authorized" ||
    decision.userId !== session.userId ||
    decision.organizationId !== session.organizationId ||
    !decision.authorization ||
    typeof decision.authorization !== "object"
  ) {
    return false;
  }
  const authorization = decision.authorization as Record<string, unknown>;
  const credential =
    authorization.credential && typeof authorization.credential === "object"
      ? (authorization.credential as Record<string, unknown>)
      : null;
  return (
    authorization.v === INFERENCE_AUTHORIZATION_BOUNDARY_VERSION &&
    authorization.organizationId === session.organizationId &&
    isRevision(authorization.organizationRevision) &&
    authorization.userId === session.userId &&
    isRevision(authorization.userRevision) &&
    credential?.kind === "app_session" &&
    credential.id === fingerprint &&
    credential.fingerprint === fingerprint &&
    credential.revision === String(session.issuedAt) &&
    credential.expiresAt === session.expiresAt
  );
}

function rejection(
  fingerprint: string,
  decision: "rejected" | "suspended",
  status: 401 | 403,
): CachedRejectedDecision {
  return {
    v: DECISION_VERSION,
    cachedAt: Date.now(),
    decision,
    status,
    credentialFingerprint: fingerprint,
  };
}

async function writeDecision(
  fingerprint: string,
  session: ValidatedSession,
  decision: CachedDecision,
): Promise<void> {
  const remainingSeconds = Math.floor((session.expiresAt - Date.now()) / 1_000);
  if (remainingSeconds <= 0) return;
  const outcome = await cache.setWithOutcome(
    CacheKeys.inference.sessionAuthContext(fingerprint),
    decision,
    Math.min(CacheTTL.inference.authContext, remainingSeconds),
    { keyClass: "inference_auth" },
  );
  if (outcome.kind !== "written") {
    throw new Error(`Eliza App inference authorization cache write failed: ${outcome.kind}`);
  }
}

async function hydrate(session: ValidatedSession, fingerprint: string): Promise<void> {
  const user = await usersRepository.findWithOrganizationForWrite(session.userId);
  let decision: CachedDecision;
  if (
    !user ||
    !user.is_active ||
    user.deleted_at !== null ||
    !user.organization_id ||
    !user.organization ||
    !user.organization.is_active ||
    user.organization_id !== session.organizationId ||
    session.issuedAt < user.inference_session_not_before
  ) {
    decision = rejection(fingerprint, "rejected", user?.is_active === false ? 403 : 401);
  } else if (await adminService.shouldBlockUser(user.id)) {
    decision = rejection(fingerprint, "suspended", 403);
  } else {
    const authorization: InferenceAuthorizationProof = {
      v: INFERENCE_AUTHORIZATION_BOUNDARY_VERSION,
      organizationId: user.organization_id,
      organizationRevision: String(user.organization.inference_auth_revision),
      userId: user.id,
      userRevision: String(user.inference_auth_revision),
      credential: {
        kind: "app_session",
        id: fingerprint,
        fingerprint,
        revision: String(session.issuedAt),
        expiresAt: session.expiresAt,
      },
    };
    await initializeInferenceAuthorizationBoundary(user.organization_id);
    await applyInferenceAuthorizationStates(user.organization_id, [
      organizationAuthorizationState(user.organization),
      userAuthorizationState(user),
      moderationAuthorizationState(user, false),
      stewardSessionAuthorizationState(user),
    ]);
    decision = {
      v: DECISION_VERSION,
      cachedAt: Date.now(),
      decision: "authorized",
      credentialFingerprint: fingerprint,
      userId: user.id,
      organizationId: user.organization_id,
      authorization,
    };
  }
  await writeDecision(fingerprint, session, decision);
}

function scheduleHydration(
  session: ValidatedSession,
  fingerprint: string,
  executionCtx: ElizaAppInferenceExecutionContext,
): void {
  let hydration = hydrationFlights.get(fingerprint);
  if (!hydration) {
    const current = hydrate(session, fingerprint).finally(() => {
      if (hydrationFlights.get(fingerprint) === current) {
        hydrationFlights.delete(fingerprint);
      }
    });
    hydration = current;
    hydrationFlights.set(fingerprint, current);
  }
  executionCtx.waitUntil(
    hydration.catch((error) => {
      // error-policy:J7 the current request is explicitly warming; a later
      // retry re-attempts hydration while this failure remains observable.
      logger.error("[ElizaAppInferenceAuth] Background hydration failed", {
        userId: session.userId,
        organizationId: session.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

/**
 * Verify one app JWT locally and resolve only a cached authorization decision.
 */
export async function resolveElizaAppInferenceSession(
  request: Request,
  executionCtx: ElizaAppInferenceExecutionContext,
): Promise<ElizaAppInferenceAuthResolution> {
  const token = bearerToken(request);
  if (!token) return { kind: "not_app_session" };
  const session = await elizaAppSessionService.validateSession(token);
  if (!session) return { kind: "rejected", status: 401 };
  const fingerprint = credentialFingerprint(token);
  const outcome = await cache.getWithOutcome<unknown>(
    CacheKeys.inference.sessionAuthContext(fingerprint),
    { keyClass: "inference_auth" },
  );
  if (outcome.kind === "hit") {
    if (!isCachedDecision(outcome.value, fingerprint, session)) {
      await cache.del(CacheKeys.inference.sessionAuthContext(fingerprint), {
        keyClass: "inference_auth",
      });
      scheduleHydration(session, fingerprint, executionCtx);
      return { kind: "warming" };
    }
    if (outcome.value.decision === "authorized") {
      return {
        kind: "authorized",
        identity: {
          userId: outcome.value.userId,
          organizationId: outcome.value.organizationId,
          authorization: outcome.value.authorization,
        },
      };
    }
    return { kind: "rejected", status: outcome.value.status };
  }
  scheduleHydration(session, fingerprint, executionCtx);
  return { kind: "warming" };
}

/** Test hook for isolating coalesced background work. */
export function __clearElizaAppInferenceAuthHydrations(): void {
  hydrationFlights.clear();
}
