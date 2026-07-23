/**
 * Strong revocation control for cache-authorized inference.
 *
 * Positive authorization snapshots may be served from eventually consistent
 * Cloudflare KV, but provider dispatch is serialized through the organization's
 * admission Durable Object. Persistent deny records in that object are the
 * revocation boundary; cache deletion remains hygiene rather than authority.
 */

import { ElizaError } from "@elizaos/core";
import type {
  RuntimeDurableObjectNamespace,
  RuntimeDurableObjectStub,
} from "../../types/cloud-worker-env";
import { getCloudBinding } from "../runtime/cloud-bindings";
import { isInferenceAuthCacheEnabled } from "./inference-hot-path-caches";

export const INFERENCE_AUTHORIZATION_BOUNDARY_VERSION = 1 as const;

export type InferenceCredentialKind = "api_key" | "steward_session";

export interface InferenceAuthorizationProof {
  readonly v: typeof INFERENCE_AUTHORIZATION_BOUNDARY_VERSION;
  readonly organizationId: string;
  readonly organizationRevision: string;
  readonly userId: string;
  readonly userRevision: string;
  readonly credential: {
    readonly kind: InferenceCredentialKind;
    /** Database row ID for API keys; full token hash for Steward sessions. */
    readonly id: string;
    /** Full SHA-256 identity, so rotations cannot reuse a stale grant. */
    readonly fingerprint: string;
    readonly revision: string;
    readonly expiresAt: number | null;
  };
}

export type InferenceAuthorizationTargetState =
  | {
      readonly kind: "organization";
      readonly id: string;
      readonly revision: string;
      readonly denied: boolean;
    }
  | {
      readonly kind: "user";
      readonly id: string;
      readonly revision: string;
      readonly denied: boolean;
    }
  | {
      readonly kind: "moderation";
      readonly id: string;
      readonly revision: string;
      readonly denied: boolean;
    }
  | {
      readonly kind: "session";
      readonly id: string;
      /** Earliest accepted Steward JWT `iat`, expressed as Unix seconds. */
      readonly revision: string;
      readonly denied: boolean;
    }
  | {
      readonly kind: "credential";
      readonly id: string;
      readonly credentialKind: InferenceCredentialKind;
      readonly fingerprint: string;
      readonly revision: string;
      readonly denied: boolean;
      readonly userId: string;
      readonly expiresAt: number | null;
    };

const GATE_BINDING = "INFERENCE_ADMISSION_GATES";
const GATE_ORIGIN = "https://inference-admission.internal";
const AUTHORIZATION_OPERATION_TIMEOUT_MS = 1_500;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REVISION = /^(0|[1-9]\d*)$/;

function validId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}

/** Reject cache payloads that cannot name one immutable authorization. */
export function isInferenceAuthorizationProof(
  value: unknown,
): value is InferenceAuthorizationProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Record<string, unknown>;
  if (
    proof.v !== INFERENCE_AUTHORIZATION_BOUNDARY_VERSION ||
    !validId(proof.organizationId) ||
    typeof proof.organizationRevision !== "string" ||
    !REVISION.test(proof.organizationRevision) ||
    !validId(proof.userId) ||
    typeof proof.userRevision !== "string" ||
    !REVISION.test(proof.userRevision) ||
    !proof.credential ||
    typeof proof.credential !== "object"
  ) {
    return false;
  }
  const credential = proof.credential as Record<string, unknown>;
  return (
    (credential.kind === "api_key" || credential.kind === "steward_session") &&
    validId(credential.id) &&
    typeof credential.fingerprint === "string" &&
    SHA256_HEX.test(credential.fingerprint) &&
    typeof credential.revision === "string" &&
    REVISION.test(credential.revision) &&
    (credential.expiresAt === null ||
      (Number.isSafeInteger(credential.expiresAt) && (credential.expiresAt as number) > 0))
  );
}

function gateStub(organizationId: string): RuntimeDurableObjectStub {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>(GATE_BINDING);
  if (!namespace) {
    throw new ElizaError("Inference authorization Durable Object binding is missing", {
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_MISSING",
      context: { organizationId },
      severity: "fatal",
    });
  }
  return namespace.getByName(organizationId);
}

async function mutateBoundary(
  organizationId: string,
  path: "/authorization/initialize" | "/authorization/apply" | "/authorization/apply-batch",
  body: Record<string, unknown>,
): Promise<void> {
  if (!validId(organizationId)) {
    throw new ElizaError("Inference authorization organization is invalid", {
      code: "INFERENCE_AUTHORIZATION_ORGANIZATION_INVALID",
      context: { organizationId },
      severity: "fatal",
    });
  }
  let response: Response;
  try {
    response = await gateStub(organizationId).fetch(
      new Request(`${GATE_ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AUTHORIZATION_OPERATION_TIMEOUT_MS),
      }),
    );
  } catch (cause) {
    // error-policy:J2 the caller needs the failed organization and mutation
    // while the transport error remains available for retry classification.
    throw new ElizaError("Inference authorization boundary mutation failed", {
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_UNAVAILABLE",
      cause,
      context: { organizationId, path },
      severity: "ephemeral",
    });
  }
  if (!response.ok) {
    throw new ElizaError("Inference authorization boundary rejected a mutation", {
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
      context: { organizationId, path, status: response.status },
      severity: response.status >= 500 ? "ephemeral" : "fatal",
    });
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    // error-policy:J3 malformed Durable Object replies never confirm a
    // security-state transition.
    throw new ElizaError("Inference authorization boundary returned malformed JSON", {
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_RESPONSE_INVALID",
      cause: error,
      context: { organizationId, path },
      severity: "fatal",
    });
  }
  if (
    !result ||
    typeof result !== "object" ||
    (result as Record<string, unknown>).applied !== true ||
    (result as Record<string, unknown>).authBoundaryVersion !==
      INFERENCE_AUTHORIZATION_BOUNDARY_VERSION
  ) {
    throw new ElizaError("Inference authorization boundary did not confirm the mutation", {
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_UNCONFIRMED",
      context: { organizationId, path },
      severity: "fatal",
    });
  }
}

/**
 * Recheck one cache-derived proof in the organization Durable Object
 * immediately before zero-rated provider work. The versioned acknowledgement
 * prevents a mixed Worker deployment from treating an older object response as
 * a completed strong-authorization check.
 */
export async function authorizeInferenceProviderDispatch(params: {
  organizationId: string;
  authorization: InferenceAuthorizationProof | undefined;
}): Promise<void> {
  if (!isInferenceAuthCacheEnabled()) return;
  if (
    !validId(params.organizationId) ||
    !isInferenceAuthorizationProof(params.authorization) ||
    params.authorization.organizationId !== params.organizationId
  ) {
    throw new ElizaError("Inference provider dispatch requires a valid authorization proof", {
      code: "INFERENCE_AUTHORIZATION_PROOF_REQUIRED",
      context: { organizationId: params.organizationId },
      severity: "fatal",
    });
  }

  let response: Response;
  try {
    response = await gateStub(params.organizationId).fetch(
      new Request(`${GATE_ORIGIN}/authorization/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: params.organizationId,
          authorization: params.authorization,
        }),
        signal: AbortSignal.timeout(AUTHORIZATION_OPERATION_TIMEOUT_MS),
      }),
    );
  } catch (cause) {
    if (cause instanceof ElizaError) throw cause;
    // error-policy:J2 preserve the Durable Object transport failure so the
    // caller can classify a fail-closed provider boundary.
    throw new ElizaError("Inference provider authorization check is unavailable", {
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_UNAVAILABLE",
      cause,
      context: { organizationId: params.organizationId },
      severity: "ephemeral",
    });
  }
  if (!response.ok) {
    throw new ElizaError(
      response.status === 403
        ? "Access denied: inference authorization was revoked"
        : "Inference provider authorization check was rejected",
      {
        code:
          response.status === 403
            ? "INFERENCE_AUTHORIZATION_REVOKED"
            : "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
        context: {
          organizationId: params.organizationId,
          status: response.status,
        },
        severity: response.status >= 500 ? "ephemeral" : "fatal",
      },
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch (cause) {
    // error-policy:J3 malformed replies never authorize provider dispatch.
    throw new ElizaError("Inference provider authorization response is malformed", {
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_RESPONSE_INVALID",
      cause,
      context: { organizationId: params.organizationId },
      severity: "fatal",
    });
  }
  if (
    !result ||
    typeof result !== "object" ||
    (result as Record<string, unknown>).authorized !== true ||
    (result as Record<string, unknown>).authCheckedVersion !==
      INFERENCE_AUTHORIZATION_BOUNDARY_VERSION
  ) {
    throw new ElizaError(
      "Inference provider authorization response did not confirm the current boundary version",
      {
        code: "INFERENCE_AUTHORIZATION_BOUNDARY_UNCONFIRMED",
        context: { organizationId: params.organizationId },
        severity: "fatal",
      },
    );
  }
}

/**
 * Establish the strong boundary before publishing the first positive KV entry.
 */
export async function initializeInferenceAuthorizationBoundary(
  organizationId: string,
): Promise<void> {
  if (!isInferenceAuthCacheEnabled()) return;
  await mutateBoundary(organizationId, "/authorization/initialize", {
    organizationId,
  });
}

/**
 * Publish authoritative lifecycle state after its database transaction commits.
 *
 * When cache authorization is disabled, Postgres/Steward remains authoritative
 * on every request and no Durable Object transition is required.
 */
export async function applyInferenceAuthorizationState(
  organizationId: string,
  state: InferenceAuthorizationTargetState,
): Promise<void> {
  if (!isInferenceAuthCacheEnabled()) return;
  await mutateBoundary(organizationId, "/authorization/apply", {
    organizationId,
    state,
  });
}

/** Publish several lifecycle transitions in one serialized Durable Object turn. */
export async function applyInferenceAuthorizationStates(
  organizationId: string,
  states: readonly InferenceAuthorizationTargetState[],
): Promise<void> {
  if (!isInferenceAuthCacheEnabled() || states.length === 0) return;
  await mutateBoundary(organizationId, "/authorization/apply-batch", {
    organizationId,
    states,
  });
}
