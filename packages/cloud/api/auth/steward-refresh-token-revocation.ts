/**
 * Revokes a Steward refresh token at its authoritative upstream boundary.
 *
 * Browser cookie deletion is only local hygiene: logout callers use this
 * helper before clearing an environment-owned refresh cookie so a copied token
 * cannot rotate into a fresh access credential after local inference revocation.
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

function resolveStewardBaseUrl(env: StewardRefreshRevocationEnv): string | null {
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

/** Revoke one refresh token before its browser cookie is destroyed. */
export async function revokeStewardRefreshToken(
  refreshToken: string,
  env: StewardRefreshRevocationEnv,
): Promise<void> {
  if (refreshToken.length === 0) {
    throw new ElizaError("Steward refresh token is missing", {
      code: "STEWARD_REFRESH_REVOCATION_TOKEN_MISSING",
      severity: "fatal",
    });
  }
  const baseUrl = resolveStewardBaseUrl(env);
  if (!baseUrl) {
    throw new ElizaError("Steward refresh revocation upstream is not configured", {
      code: "STEWARD_REFRESH_REVOCATION_UPSTREAM_MISSING",
      severity: "ephemeral",
    });
  }

  const bodyText = JSON.stringify({ refreshToken });
  const bodyBytes = new TextEncoder().encode(bodyText);
  const revokeUrl = new URL(`${baseUrl}/auth/revoke`);
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
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
      "POST",
      `${revokeUrl.pathname}${revokeUrl.search}`,
      headers,
      bodyBytes,
    );
  }

  let response: Response;
  try {
    response = await fetch(revokeUrl, {
      method: "POST",
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(STEWARD_AUTH_UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    // error-policy:J2 preserve timeout/transport detail for the logout boundary.
    throw new ElizaError("Steward refresh revocation transport failed", {
      code: "STEWARD_REFRESH_REVOCATION_UNAVAILABLE",
      cause,
      severity: "ephemeral",
    });
  }
  if (!response.ok) {
    throw new ElizaError("Steward refresh revocation was rejected", {
      code: "STEWARD_REFRESH_REVOCATION_REJECTED",
      context: { status: response.status },
      severity: response.status >= 500 ? "ephemeral" : "fatal",
    });
  }
  const responseText = await response.text();
  if (responseText.length > 0) {
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch (cause) {
      // error-policy:J3 an ambiguous success body cannot confirm that the
      // authoritative refresh credential was actually revoked.
      throw new ElizaError("Steward refresh revocation response is malformed", {
        code: "STEWARD_REFRESH_REVOCATION_RESPONSE_INVALID",
        cause,
        severity: "fatal",
      });
    }
    if (
      payload !== null &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).ok === false
    ) {
      throw new ElizaError("Steward refresh revocation was not confirmed", {
        code: "STEWARD_REFRESH_REVOCATION_UNCONFIRMED",
        severity: "fatal",
      });
    }
  }
}
