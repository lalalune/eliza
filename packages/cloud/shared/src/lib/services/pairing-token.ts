/**
 * Issues and atomically consumes origin-bound dedicated-agent pairing tokens.
 * Callers may inspect a token before consumption so account and organization
 * eligibility can be checked without burning the one-time capability.
 */
import { agentPairingTokensRepository } from "../../db/repositories/agent-pairing-tokens";
import { getAlternateDomainOrigins } from "./pairing-token-domains";

interface PairingToken {
  userId: string;
  orgId: string;
  agentId: string;
  instanceUrl: string;
  expectedOrigin: string;
  expiresAt: number;
  createdAt: number;
}

const TOKEN_EXPIRY_MS = 60_000; // 60 seconds

async function hashToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;

    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 0x03) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) {
      encoded += alphabet[((b & 0x0f) << 2) | (c >> 6)];
    }
    if (i + 2 < bytes.length) {
      encoded += alphabet[c & 0x3f];
    }
  }

  return encoded;
}

function createPairingToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function normalizeOrigin(expectedOrigin?: string | null): string | null {
  if (!expectedOrigin) return null;
  try {
    return new URL(expectedOrigin).origin;
  } catch {
    // error-policy:J3 an untrusted Origin that cannot be parsed is explicitly
    // invalid and never falls back to an unscoped token lookup.
    return null;
  }
}

function pairingTokenFromRow(row: {
  user_id: string;
  organization_id: string;
  agent_id: string;
  instance_url: string;
  expected_origin: string;
  expires_at: Date;
  created_at: Date;
}): PairingToken {
  return {
    userId: row.user_id,
    orgId: row.organization_id,
    agentId: row.agent_id,
    instanceUrl: row.instance_url,
    expectedOrigin: row.expected_origin,
    expiresAt: row.expires_at.getTime(),
    createdAt: row.created_at.getTime(),
  };
}

function allowedOrigins(origin: string): string[] {
  return [origin, ...getAlternateDomainOrigins(origin)];
}

class PairingTokenService {
  async generateToken(
    userId: string,
    orgId: string,
    agentId: string,
    instanceUrl: string,
  ): Promise<string> {
    const expectedOrigin = new URL(instanceUrl).origin;
    const token = createPairingToken();
    const now = Date.now();

    await agentPairingTokensRepository.create({
      token_hash: await hashToken(token),
      organization_id: orgId,
      user_id: userId,
      agent_id: agentId,
      instance_url: instanceUrl,
      expected_origin: expectedOrigin,
      expires_at: new Date(now + TOKEN_EXPIRY_MS),
    });

    return token;
  }

  /**
   * Resolve a valid token without setting `used_at`. The route uses this phase
   * only to load the immutable user/org/agent scope needed for eligibility
   * checks; `validateToken` remains the atomic one-time consumption boundary.
   */
  async inspectToken(token: string, expectedOrigin?: string | null): Promise<PairingToken | null> {
    const normalizedOrigin = normalizeOrigin(expectedOrigin);
    if (!normalizedOrigin) return null;

    const row = await agentPairingTokensRepository.findByTokenHash(await hashToken(token));
    if (
      !row ||
      row.used_at ||
      row.expires_at.getTime() <= Date.now() ||
      !allowedOrigins(normalizedOrigin).includes(row.expected_origin)
    ) {
      return null;
    }
    return pairingTokenFromRow(row);
  }

  async validateToken(token: string, expectedOrigin?: string | null): Promise<PairingToken | null> {
    const normalizedOrigin = normalizeOrigin(expectedOrigin);
    if (!normalizedOrigin) return null;

    // Try the exact origin first
    let row = await agentPairingTokensRepository.consumeValidToken(
      await hashToken(token),
      normalizedOrigin,
    );

    // If no match, try each alternate domain in the same alias group. The
    // dashboard may rewrite the agent URL between any two aliased domains
    // (waifu.fun ↔ eliza.ai ↔ elizacloud.ai), and we cannot predict which
    // one is stored as `expected_origin` for a given token row.
    if (!row) {
      for (const alternateOrigin of getAlternateDomainOrigins(normalizedOrigin)) {
        row = await agentPairingTokensRepository.consumeValidToken(
          await hashToken(token),
          alternateOrigin,
        );
        if (row) break;
      }
    }

    if (!row) {
      return null;
    }

    return pairingTokenFromRow(row);
  }
}

let instance: PairingTokenService | null = null;

export function getPairingTokenService(): PairingTokenService {
  if (!instance) {
    instance = new PairingTokenService();
  }
  return instance;
}

export type { PairingToken };
