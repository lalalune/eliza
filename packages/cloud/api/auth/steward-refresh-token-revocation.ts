/**
 * Revokes every Steward session for an authenticated user.
 *
 * Steward serializes `DELETE /auth/sessions` with refresh rotation under the
 * same per-user lock. Logout callers use this boundary before clearing browser
 * credentials so a concurrent rotation cannot leave a usable token family.
 */

import { ElizaError } from "@elizaos/core";
import {
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS,
  type StewardVerifyEnv,
} from "@/lib/auth/steward-client";
import { signStewardMutatingRequest } from "@/lib/steward/sign";

interface StewardRefreshRevocationEnv extends StewardVerifyEnv {
  NEXT_PUBLIC_STEWARD_API_URL?: string;
  STEWARD_API_URL?: string;
  STEWARD_REQUEST_SIGNING_SECRET?: string;
  STEWARD_TENANT_ID?: string;
}

function resolveStewardBaseUrl(
  env: StewardRefreshRevocationEnv,
): string | null {
  for (const candidate of [
    env.STEWARD_API_URL,
    env.NEXT_PUBLIC_STEWARD_API_URL,
  ]) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }
    try {
      const url = new URL(candidate.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return candidate.trim().replace(/\/+$/, "");
    } catch {
      // error-policy:J3 malformed configuration is skipped; all-invalid is an
      // explicit unavailable result below, never a successful local logout.
    }
  }
  return null;
}

function confirmedSuccessPayload(responseText: string): boolean {
  if (responseText.trim().length === 0) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return false;
  }
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).ok === true
  );
}

/**
 * Revoke all refresh tokens and the access-token epoch for one Steward user.
 *
 * The upstream contract is deliberately bodyless. `Authorization` is added
 * before request signing because Steward includes its hash in the canonical
 * signature. Success requires the documented `{ ok: true }` response; an
 * empty or ambiguous 2xx must never authorize local cookie deletion.
 */
export async function revokeStewardUserSessions(
  accessToken: string,
  env: StewardRefreshRevocationEnv,
): Promise<void> {
  if (accessToken.trim().length === 0) {
    throw new ElizaError("Steward access token is missing", {
      code: "STEWARD_SESSION_REVOCATION_TOKEN_MISSING",
      severity: "fatal",
    });
  }
  const baseUrl = resolveStewardBaseUrl(env);
  if (!baseUrl) {
    throw new ElizaError(
      "Steward session revocation upstream is not configured",
      {
        code: "STEWARD_SESSION_REVOCATION_UPSTREAM_MISSING",
        severity: "ephemeral",
      },
    );
  }

  const revokeUrl = new URL(`${baseUrl}/auth/sessions`);
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  });
  if (
    typeof env.STEWARD_TENANT_ID === "string" &&
    env.STEWARD_TENANT_ID.trim().length > 0
  ) {
    headers.set("X-Steward-Tenant", env.STEWARD_TENANT_ID.trim());
  }
  if (
    typeof env.STEWARD_REQUEST_SIGNING_SECRET === "string" &&
    env.STEWARD_REQUEST_SIGNING_SECRET.length > 0
  ) {
    await signStewardMutatingRequest(
      env.STEWARD_REQUEST_SIGNING_SECRET,
      "DELETE",
      `${revokeUrl.pathname}${revokeUrl.search}`,
      headers,
      new Uint8Array(),
    );
  }

  let response: Response;
  try {
    response = await fetch(revokeUrl, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(STEWARD_AUTH_UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    // error-policy:J2 preserve timeout/transport detail for the logout boundary.
    throw new ElizaError("Steward session revocation transport failed", {
      code: "STEWARD_SESSION_REVOCATION_UNAVAILABLE",
      cause,
      severity: "ephemeral",
    });
  }
  if (!response.ok) {
    throw new ElizaError("Steward session revocation was rejected", {
      code: "STEWARD_SESSION_REVOCATION_REJECTED",
      context: { status: response.status },
      severity: response.status >= 500 ? "ephemeral" : "fatal",
    });
  }
  const responseText = await response.text();
  if (!confirmedSuccessPayload(responseText)) {
    // error-policy:J3 a 2xx without explicit confirmation cannot prove the
    // serialized family revocation completed.
    throw new ElizaError("Steward session revocation was not confirmed", {
      code: "STEWARD_SESSION_REVOCATION_UNCONFIRMED",
      severity: "fatal",
    });
  }
}
