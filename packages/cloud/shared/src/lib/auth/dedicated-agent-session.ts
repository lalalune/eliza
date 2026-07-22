/**
 * Mints and verifies the user-bound credential stored by a paired dedicated
 * agent UI. The token is scoped to one Cloud user, organization, and agent so
 * the edge can exchange it for container auth without exposing the shared
 * agent token or accepting caller-selected workflow principals.
 */
import { ElizaError } from "@elizaos/core/errors";
import { jwtVerify, SignJWT } from "jose";
import { getAlgorithm, getKeyId, getPrivateKey, getPublicKey, isJWKSConfigured } from "./jwks";

export const DEDICATED_AGENT_SESSION_AUDIENCE = "dedicated-agent-session";
export const DEDICATED_AGENT_SESSION_ISSUER = "https://elizacloud.ai/dedicated-agent-session";
export const DEDICATED_AGENT_SESSION_TOKEN_TYPE = "eliza-dedicated-agent-session+jwt";
export const DEDICATED_AGENT_SESSION_VERSION = 1;
export const DEDICATED_AGENT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

let validatedPrivateKey: CryptoKey | null = null;
let validatedPublicKey: CryptoKey | null = null;

export interface DedicatedAgentSessionClaims {
  userId: string;
  organizationId: string;
  agentId: string;
}

export type DedicatedAgentSessionVerification =
  | { valid: true; claims: DedicatedAgentSessionClaims }
  | { valid: false; code: "not_configured" | "invalid_token" };

export type DedicatedAgentSessionSigningReadiness =
  | { ready: true }
  | {
      ready: false;
      code: "not_configured" | "invalid_configuration";
    };

/** Bind tokens to the Cloud environment even when deployments share a key. */
export function dedicatedAgentSessionIssuer(cloudOriginOrDomain?: string): string {
  const configured = cloudOriginOrDomain?.trim();
  if (configured?.includes("://")) {
    let origin: URL;
    try {
      origin = new URL(configured);
    } catch (error) {
      throw new ElizaError("Dedicated agent session domain is invalid", {
        code: "DEDICATED_AGENT_SESSION_DOMAIN_INVALID",
        cause: error,
      });
    }
    const isLoopbackHttp =
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname.toLowerCase());
    if (
      (origin.protocol !== "https:" && !isLoopbackHttp) ||
      origin.username ||
      origin.password ||
      (origin.pathname !== "/" && origin.pathname !== "") ||
      origin.search ||
      origin.hash
    ) {
      throw new ElizaError("Dedicated agent session domain is invalid", {
        code: "DEDICATED_AGENT_SESSION_DOMAIN_INVALID",
      });
    }
    return `${origin.origin.toLowerCase()}/dedicated-agent-session`;
  }
  const domain = configured?.toLowerCase() ?? "elizacloud.ai";
  const domainIsValid =
    domain.length > 0 &&
    domain.length <= 253 &&
    domain
      .split(".")
      .every(
        (label) =>
          label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      );
  if (!domainIsValid) {
    throw new ElizaError("Dedicated agent session domain is invalid", {
      code: "DEDICATED_AGENT_SESSION_DOMAIN_INVALID",
    });
  }
  return `https://${domain}/dedicated-agent-session`;
}

/** Prefer the Cloud identity origin over the independently configurable agent ingress domain. */
export function dedicatedAgentSessionIssuerFromEnvironment(env: {
  ELIZA_CLOUD_URL?: string;
  ELIZA_CLOUD_AGENT_BASE_DOMAIN?: string;
}): string {
  return dedicatedAgentSessionIssuer(env.ELIZA_CLOUD_URL ?? env.ELIZA_CLOUD_AGENT_BASE_DOMAIN);
}

function requireClaim(
  payload: Record<string, unknown>,
  key: keyof DedicatedAgentSessionClaims,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ElizaError(`Dedicated agent session is missing ${key}`, {
      code: "DEDICATED_AGENT_SESSION_CLAIM_MISSING",
      context: { claim: key },
    });
  }
  return value.trim();
}

function assertClaims(claims: DedicatedAgentSessionClaims): void {
  for (const [key, value] of Object.entries(claims)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new ElizaError(`Dedicated agent session ${key} is required`, {
        code: "DEDICATED_AGENT_SESSION_CLAIM_REQUIRED",
        context: { claim: key },
      });
    }
  }
}

/** Prove that the configured ES256 keys parse and form one signing pair. */
export async function validateDedicatedAgentSessionSigningConfig(): Promise<DedicatedAgentSessionSigningReadiness> {
  if (!isJWKSConfigured()) {
    return { ready: false, code: "not_configured" };
  }

  try {
    const [privateKey, publicKey] = await Promise.all([getPrivateKey(), getPublicKey()]);
    if (privateKey === validatedPrivateKey && publicKey === validatedPublicKey) {
      return { ready: true };
    }

    // Parsing each key is insufficient: two independently valid keys would
    // mint sessions that the edge can never verify. A signed probe proves the
    // pair while keeping all key material out of logs and return values.
    const probe = await new SignJWT({ readiness: true })
      .setProtectedHeader({ alg: getAlgorithm(), typ: DEDICATED_AGENT_SESSION_TOKEN_TYPE })
      .sign(privateKey);
    await jwtVerify(probe, publicKey, { algorithms: [getAlgorithm()] });
    validatedPrivateKey = privateKey;
    validatedPublicKey = publicKey;
    return { ready: true };
  } catch {
    // error-policy:J3 deployment-provided key material is an untrusted runtime
    // boundary; malformed or mismatched keys produce an explicit invalid state.
    return { ready: false, code: "invalid_configuration" };
  }
}

export async function mintDedicatedAgentSession(
  claims: DedicatedAgentSessionClaims,
  options: { now?: () => number; issuer?: string } = {},
): Promise<{ token: string; expiresAt: string }> {
  const signingReadiness = await validateDedicatedAgentSessionSigningConfig();
  if (!signingReadiness.ready) {
    throw new ElizaError("Dedicated agent session signing is unavailable", {
      code: "DEDICATED_AGENT_SESSION_SIGNING_UNAVAILABLE",
      context: { readinessCode: signingReadiness.code },
      severity: "fatal",
    });
  }
  assertClaims(claims);
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const expiresAtSeconds = nowSeconds + DEDICATED_AGENT_SESSION_TTL_SECONDS;
  const token = await new SignJWT({
    userId: claims.userId.trim(),
    organizationId: claims.organizationId.trim(),
    agentId: claims.agentId.trim(),
    sessionVersion: DEDICATED_AGENT_SESSION_VERSION,
  })
    .setProtectedHeader({
      alg: getAlgorithm(),
      kid: getKeyId(),
      typ: DEDICATED_AGENT_SESSION_TOKEN_TYPE,
    })
    .setIssuer(options.issuer ?? DEDICATED_AGENT_SESSION_ISSUER)
    .setAudience(DEDICATED_AGENT_SESSION_AUDIENCE)
    .setSubject(claims.userId.trim())
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(expiresAtSeconds)
    .setJti(crypto.randomUUID())
    .sign(await getPrivateKey());
  return {
    token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export async function verifyDedicatedAgentSession(
  token: string,
  expectedAgentId: string,
  options: { now?: () => number; issuer?: string } = {},
): Promise<DedicatedAgentSessionVerification> {
  if (!isJWKSConfigured()) return { valid: false, code: "not_configured" };
  try {
    const verified = await jwtVerify(token, await getPublicKey(), {
      issuer: options.issuer ?? DEDICATED_AGENT_SESSION_ISSUER,
      audience: DEDICATED_AGENT_SESSION_AUDIENCE,
      algorithms: [getAlgorithm()],
      ...(options.now ? { currentDate: new Date(options.now()) } : {}),
    });
    const payload = verified.payload as Record<string, unknown>;
    const claims: DedicatedAgentSessionClaims = {
      userId: requireClaim(payload, "userId"),
      organizationId: requireClaim(payload, "organizationId"),
      agentId: requireClaim(payload, "agentId"),
    };
    if (
      verified.protectedHeader.typ !== DEDICATED_AGENT_SESSION_TOKEN_TYPE ||
      payload.sessionVersion !== DEDICATED_AGENT_SESSION_VERSION ||
      payload.sub !== claims.userId ||
      claims.agentId !== expectedAgentId.trim()
    ) {
      return { valid: false, code: "invalid_token" };
    }
    return { valid: true, claims };
  } catch {
    // error-policy:J3 malformed, expired, or incorrectly scoped bearer input
    // yields an explicit invalid result and never a partially trusted identity.
    return { valid: false, code: "invalid_token" };
  }
}
