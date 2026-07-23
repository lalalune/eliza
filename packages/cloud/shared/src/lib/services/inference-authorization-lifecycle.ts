/**
 * Converts authoritative lifecycle rows into Durable Object authorization state.
 *
 * Mutation services publish these snapshots with fail-closed ordering: a
 * restrictive snapshot is durable before its database transaction commits,
 * while a permissive snapshot is published only after commit.
 */

import { ElizaError } from "@elizaos/core";
import type { ApiKey, Organization, User } from "../../db/repositories";
import type { InferenceAuthorizationTargetState } from "./inference-authorization-boundary";

function revision(value: number | bigint | string): string {
  const normalized = String(value);
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new ElizaError("Inference authorization revision is invalid", {
      code: "INFERENCE_AUTHORIZATION_REVISION_INVALID",
      context: { revision: normalized },
      severity: "fatal",
    });
  }
  return normalized;
}

export function organizationAuthorizationState(
  organization: Pick<Organization, "id" | "is_active" | "inference_auth_revision">,
): InferenceAuthorizationTargetState {
  return {
    kind: "organization",
    id: organization.id,
    revision: revision(organization.inference_auth_revision),
    denied: !organization.is_active,
  };
}

export function userAuthorizationState(
  user: Pick<User, "id" | "is_active" | "deleted_at" | "inference_auth_revision">,
  denied = !user.is_active || user.deleted_at !== null,
): InferenceAuthorizationTargetState {
  return {
    kind: "user",
    id: user.id,
    revision: revision(user.inference_auth_revision),
    denied,
  };
}

export function moderationAuthorizationState(
  user: Pick<User, "id" | "inference_auth_revision">,
  denied: boolean,
): InferenceAuthorizationTargetState {
  return {
    kind: "moderation",
    id: user.id,
    revision: revision(user.inference_auth_revision),
    denied,
  };
}

export function stewardSessionAuthorizationState(
  user: Pick<User, "id" | "inference_session_not_before">,
): InferenceAuthorizationTargetState {
  return {
    kind: "session",
    id: user.id,
    revision: revision(user.inference_session_not_before),
    denied: false,
  };
}

export function apiKeyAuthorizationState(
  apiKey: Pick<
    ApiKey,
    | "id"
    | "user_id"
    | "key_hash"
    | "is_active"
    | "deleted_at"
    | "expires_at"
    | "inference_auth_revision"
  >,
): InferenceAuthorizationTargetState {
  const expiresAt = apiKey.expires_at ? new Date(apiKey.expires_at).getTime() : null;
  return {
    kind: "credential",
    id: apiKey.id,
    credentialKind: "api_key",
    fingerprint: apiKey.key_hash,
    revision: revision(apiKey.inference_auth_revision),
    denied:
      !apiKey.is_active ||
      apiKey.deleted_at !== null ||
      (expiresAt !== null && expiresAt <= Date.now()),
    userId: apiKey.user_id,
    expiresAt,
  };
}
