/**
 * Exercises the real ES256 mint/verify path for paired dedicated-agent
 * sessions, including tenant scope, expiry, and malformed-input rejection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  DEDICATED_AGENT_SESSION_AUDIENCE,
  DEDICATED_AGENT_SESSION_ISSUER,
  DEDICATED_AGENT_SESSION_TOKEN_TYPE,
  DEDICATED_AGENT_SESSION_TTL_SECONDS,
  DEDICATED_AGENT_SESSION_VERSION,
  dedicatedAgentSessionIssuer,
  dedicatedAgentSessionIssuerFromEnvironment,
  mintDedicatedAgentSession,
  validateDedicatedAgentSessionSigningConfig,
  verifyDedicatedAgentSession,
} from "./dedicated-agent-session";

const CLAIMS = {
  userId: "user-1",
  organizationId: "org-1",
  agentId: "agent-1",
};

const savedEnv: Record<string, string | undefined> = {};
let signingPrivateKey: CryptoKey;
let configuredPrivateKey: string;
let configuredPublicKey: string;

function restoreEnv(name: string): void {
  const value = savedEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  signingPrivateKey = privateKey;
  for (const name of ["JWT_SIGNING_PRIVATE_KEY", "JWT_SIGNING_PUBLIC_KEY", "JWT_SIGNING_KEY_ID"]) {
    savedEnv[name] = process.env[name];
  }
  configuredPrivateKey = Buffer.from(await exportPKCS8(privateKey)).toString("base64");
  configuredPublicKey = Buffer.from(await exportSPKI(publicKey)).toString("base64");
  process.env.JWT_SIGNING_PRIVATE_KEY = configuredPrivateKey;
  process.env.JWT_SIGNING_PUBLIC_KEY = configuredPublicKey;
  process.env.JWT_SIGNING_KEY_ID = "dedicated-session-test";
});

afterAll(() => {
  restoreEnv("JWT_SIGNING_PRIVATE_KEY");
  restoreEnv("JWT_SIGNING_PUBLIC_KEY");
  restoreEnv("JWT_SIGNING_KEY_ID");
});

describe("dedicated agent session", () => {
  test("canonicalizes valid environment domains and rejects malformed ones", () => {
    expect(dedicatedAgentSessionIssuer("STAGING.ELIZACLOUD.AI")).toBe(
      "https://staging.elizacloud.ai/dedicated-agent-session",
    );
    expect(dedicatedAgentSessionIssuer("https://STAGING.ELIZACLOUD.AI")).toBe(
      "https://staging.elizacloud.ai/dedicated-agent-session",
    );
    expect(dedicatedAgentSessionIssuer("http://localhost:3000")).toBe(
      "http://localhost:3000/dedicated-agent-session",
    );
    expect(
      dedicatedAgentSessionIssuerFromEnvironment({
        ELIZA_CLOUD_URL: "https://staging.elizacloud.ai",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "https://",
      }),
    ).toBe("https://staging.elizacloud.ai/dedicated-agent-session");
    for (const invalidDomain of [
      "",
      "bad domain",
      "http://elizacloud.ai",
      "http://192.168.1.20:3000",
      "https://user@elizacloud.ai",
      "https://elizacloud.ai/path",
      ".elizacloud.ai",
      "elizacloud.ai.",
      "-staging.elizacloud.ai",
      "staging-.elizacloud.ai",
    ]) {
      expect(() => dedicatedAgentSessionIssuer(invalidDomain)).toThrow(/domain is invalid/);
    }
  });

  test("proves that the configured signing keys parse and match", async () => {
    await expect(validateDedicatedAgentSessionSigningConfig()).resolves.toEqual({
      ready: true,
    });
  });

  test("round-trips the user, organization, and agent scope", async () => {
    const minted = await mintDedicatedAgentSession(CLAIMS);
    const verified = await verifyDedicatedAgentSession(minted.token, CLAIMS.agentId);

    expect(verified).toEqual({ valid: true, claims: CLAIMS });
    expect(decodeProtectedHeader(minted.token).typ).toBe(DEDICATED_AGENT_SESSION_TOKEN_TYPE);
    expect(decodeJwt(minted.token).sessionVersion).toBe(DEDICATED_AGENT_SESSION_VERSION);
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());
  });

  test("rejects a signed token whose subject differs from its user claim", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      ...CLAIMS,
      sessionVersion: DEDICATED_AGENT_SESSION_VERSION,
    })
      .setProtectedHeader({
        alg: "ES256",
        kid: "dedicated-session-test",
        typ: DEDICATED_AGENT_SESSION_TOKEN_TYPE,
      })
      .setIssuer(DEDICATED_AGENT_SESSION_ISSUER)
      .setAudience(DEDICATED_AGENT_SESSION_AUDIENCE)
      .setSubject("different-user")
      .setIssuedAt(nowSeconds)
      .setNotBefore(nowSeconds)
      .setExpirationTime(nowSeconds + 60)
      .setJti(crypto.randomUUID())
      .sign(signingPrivateKey);

    await expect(verifyDedicatedAgentSession(token, CLAIMS.agentId)).resolves.toEqual({
      valid: false,
      code: "invalid_token",
    });
  });

  test("rejects signed tokens without the dedicated type or current version", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const variants = [
      {
        payload: { ...CLAIMS, sessionVersion: DEDICATED_AGENT_SESSION_VERSION },
        protectedHeader: { alg: "ES256", kid: "dedicated-session-test" },
      },
      {
        payload: { ...CLAIMS },
        protectedHeader: {
          alg: "ES256",
          kid: "dedicated-session-test",
          typ: DEDICATED_AGENT_SESSION_TOKEN_TYPE,
        },
      },
      {
        payload: { ...CLAIMS, sessionVersion: DEDICATED_AGENT_SESSION_VERSION + 1 },
        protectedHeader: {
          alg: "ES256",
          kid: "dedicated-session-test",
          typ: DEDICATED_AGENT_SESSION_TOKEN_TYPE,
        },
      },
    ];

    for (const variant of variants) {
      const token = await new SignJWT(variant.payload)
        .setProtectedHeader(variant.protectedHeader)
        .setIssuer(DEDICATED_AGENT_SESSION_ISSUER)
        .setAudience(DEDICATED_AGENT_SESSION_AUDIENCE)
        .setSubject(CLAIMS.userId)
        .setIssuedAt(nowSeconds)
        .setNotBefore(nowSeconds)
        .setExpirationTime(nowSeconds + 60)
        .setJti(crypto.randomUUID())
        .sign(signingPrivateKey);
      await expect(verifyDedicatedAgentSession(token, CLAIMS.agentId)).resolves.toEqual({
        valid: false,
        code: "invalid_token",
      });
    }
  });

  test("rejects use against a different dedicated agent", async () => {
    const minted = await mintDedicatedAgentSession(CLAIMS);

    await expect(verifyDedicatedAgentSession(minted.token, "agent-2")).resolves.toEqual({
      valid: false,
      code: "invalid_token",
    });
  });

  test("rejects a token replayed into a different Cloud environment", async () => {
    const minted = await mintDedicatedAgentSession(CLAIMS, {
      issuer: "https://staging.elizacloud.ai/dedicated-agent-session",
    });

    await expect(
      verifyDedicatedAgentSession(minted.token, CLAIMS.agentId, {
        issuer: "https://elizacloud.ai/dedicated-agent-session",
      }),
    ).resolves.toEqual({ valid: false, code: "invalid_token" });
  });

  test("rejects tampering and expiry", async () => {
    const mintedAt = 1_900_000_000_000;
    const minted = await mintDedicatedAgentSession(CLAIMS, {
      now: () => mintedAt,
    });
    const pieces = minted.token.split(".");
    const tampered = `${pieces[0]}.${pieces[1]}.invalid-signature`;

    await expect(
      verifyDedicatedAgentSession(tampered, CLAIMS.agentId, {
        now: () => mintedAt,
      }),
    ).resolves.toEqual({ valid: false, code: "invalid_token" });
    await expect(
      verifyDedicatedAgentSession(minted.token, CLAIMS.agentId, {
        now: () => mintedAt + (DEDICATED_AGENT_SESSION_TTL_SECONDS + 1) * 1000,
      }),
    ).resolves.toEqual({ valid: false, code: "invalid_token" });
  });

  test("fails minting when any identity dimension is empty", async () => {
    await expect(mintDedicatedAgentSession({ ...CLAIMS, userId: " " })).rejects.toThrow(
      /userId is required/,
    );
  });

  test("reports malformed signing material as an invalid configuration", async () => {
    process.env.JWT_SIGNING_PRIVATE_KEY = Buffer.from("not-a-private-key").toString("base64");
    try {
      await expect(validateDedicatedAgentSessionSigningConfig()).resolves.toEqual({
        ready: false,
        code: "invalid_configuration",
      });
    } finally {
      process.env.JWT_SIGNING_PRIVATE_KEY = configuredPrivateKey;
    }
  });

  test("reports independently valid but mismatched signing keys as invalid", async () => {
    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    process.env.JWT_SIGNING_PUBLIC_KEY = Buffer.from(await exportSPKI(publicKey)).toString(
      "base64",
    );
    try {
      await expect(validateDedicatedAgentSessionSigningConfig()).resolves.toEqual({
        ready: false,
        code: "invalid_configuration",
      });
    } finally {
      process.env.JWT_SIGNING_PUBLIC_KEY = configuredPublicKey;
    }
  });

  test("reports an explicit unavailable state without signing keys", async () => {
    const privateKey = process.env.JWT_SIGNING_PRIVATE_KEY;
    const publicKey = process.env.JWT_SIGNING_PUBLIC_KEY;
    delete process.env.JWT_SIGNING_PRIVATE_KEY;
    delete process.env.JWT_SIGNING_PUBLIC_KEY;
    try {
      await expect(validateDedicatedAgentSessionSigningConfig()).resolves.toEqual({
        ready: false,
        code: "not_configured",
      });
      await expect(verifyDedicatedAgentSession("token", CLAIMS.agentId)).resolves.toEqual({
        valid: false,
        code: "not_configured",
      });
    } finally {
      if (privateKey !== undefined) process.env.JWT_SIGNING_PRIVATE_KEY = privateKey;
      if (publicKey !== undefined) process.env.JWT_SIGNING_PUBLIC_KEY = publicKey;
    }
  });
});
