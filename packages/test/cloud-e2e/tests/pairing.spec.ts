/** Covers the pairing cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import { createHash, randomBytes, webcrypto } from "node:crypto";
import {
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

/**
 * Agent web-UI pairing contract.
 *
 * Grounded on real source:
 *   • POST /api/v1/eliza/agents/:agentId/pairing-token issues a one-time token
 *     when the agent is running and a managed web-UI URL resolves; the URL is
 *     derived from health_url's origin (resolveDirectWebUiUrlFromHealthUrl) and
 *     redirectUrl carries `?token=` only when ELIZA_API_TOKEN is present
 *     (supportsUiTokenPairing) — pairing-token/route.ts:65-94,252-273.
 *   • POST /api/auth/pair validates the token against the request Origin, is
 *     single-use (consumeValidToken flips used_at), and returns a scoped ES256
 *     session in the stable { apiKey } field — auth/pair/route.ts,
 *     pairing-token.ts:75-120, agent-pairing-tokens.ts consumeValidToken:25-47.
 *   • Token format must match ^[A-Za-z0-9_-]{43}$ — auth/pair/route.ts:22.
 *   • Tokens expire after 60s (TOKEN_EXPIRY_MS) and bind to one expected_origin.
 *
 * The memory provider leaves environment_vars empty and sets no web_ui_port, so
 * this test stamps ELIZA_API_TOKEN (to enable principal transport + token redirect)
 * directly on the row after it reaches running. The web-UI origin equals the
 * control-plane mock origin (health_url host).
 */

const AGENT_API_TOKEN = "eliza_agent_paired_token_value";

function plausiblePairingToken(): string {
  // 32 random bytes -> 43-char base64url, matching createPairingToken().
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function pair(
  apiUrl: string,
  token: string,
  origin: string | null,
): Promise<{
  status: number;
  body: { apiKey?: string | null; expiresAt?: string; error?: string };
}> {
  const res = await fetch(`${apiUrl}/api/auth/pair`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ token }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    apiKey?: string | null;
    expiresAt?: string;
    error?: string;
  };
  return { status: res.status, body };
}

async function verifyPairedSession(
  apiUrl: string,
  token: string,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  const jwksResponse = await fetch(`${apiUrl}/.well-known/jwks.json`);
  expect(jwksResponse.status).toBe(200);
  const jwks = (await jwksResponse.json()) as { keys?: JsonWebKey[] };
  const jwk = jwks.keys?.[0];
  expect(jwk).toBeTruthy();
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signatureValid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(parts[2] as string, "base64url"),
    Buffer.from(`${parts[0]}.${parts[1]}`),
  );
  expect(signatureValid).toBe(true);
  return JSON.parse(
    Buffer.from(parts[1] as string, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

test.describe("pairing token exchange", () => {
  test("issues a single-use, origin-bound pairing token", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const webUiOrigin = stack.urls.controlPlane;
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-pairing-agent",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      intervalMs: 250,
      onTick: processJobs,
    });

    // Stamp the agent token so the managed principal transport is available and
    // the pairing-token redirect carries `?token=`.
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    await agentSandboxesRepository.update(sandboxId, {
      environment_vars: { ELIZA_API_TOKEN: AGENT_API_TOKEN },
    });

    // Issue a token via the real endpoint.
    const tokenRes = await fetch(
      `${stack.urls.api}/api/v1/eliza/agents/${sandboxId}/pairing-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${seededUser.apiKey}` },
      },
    );
    expect(
      tokenRes.status,
      `pairing-token returned ${tokenRes.status}: ${await tokenRes.clone().text()}`,
    ).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      data?: { token?: string; redirectUrl?: string; expiresIn?: number };
    };
    const token = tokenBody.data?.token;
    expect(token, "expected a pairing token").toBeTruthy();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenBody.data?.expiresIn).toBe(60);
    // ELIZA_API_TOKEN present -> redirect points at the web UI /pair with token.
    expect(tokenBody.data?.redirectUrl).toBe(
      `${webUiOrigin}/pair?token=${token}`,
    );

    // Exchange with the correct origin -> 200 with a signed, user-scoped
    // browser session. The raw container token must never cross this boundary.
    const ok = await pair(stack.urls.api, token as string, webUiOrigin);
    expect(
      ok.status,
      `pair should succeed, got ${ok.status}: ${JSON.stringify(ok.body)}`,
    ).toBe(200);
    expect(ok.body.apiKey).toBeTruthy();
    expect(ok.body.apiKey).not.toBe(AGENT_API_TOKEN);
    expect(ok.body.expiresAt).toBeTruthy();
    const claims = await verifyPairedSession(
      stack.urls.api,
      ok.body.apiKey as string,
    );
    expect(claims).toMatchObject({
      userId: seededUser.userId,
      organizationId: seededUser.organizationId,
      agentId: sandboxId,
      sessionVersion: 1,
      sub: seededUser.userId,
      aud: "dedicated-agent-session",
    });
    expect(Number(claims.exp) * 1000).toBe(
      Date.parse(ok.body.expiresAt as string),
    );

    // Replaying the same token is rejected (single-use; used_at already set).
    const replay = await pair(stack.urls.api, token as string, webUiOrigin);
    expect(replay.status).toBe(401);
  });

  test("rejects a token presented from the wrong origin", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const webUiOrigin = stack.urls.controlPlane;
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-pairing-wrong-origin",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      intervalMs: 250,
      onTick: processJobs,
    });

    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    await agentSandboxesRepository.update(sandboxId, {
      environment_vars: { ELIZA_API_TOKEN: AGENT_API_TOKEN },
    });

    const tokenRes = await fetch(
      `${stack.urls.api}/api/v1/eliza/agents/${sandboxId}/pairing-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${seededUser.apiKey}` },
      },
    );
    expect(tokenRes.status).toBe(200);
    const token = ((await tokenRes.json()) as { data?: { token?: string } })
      .data?.token;
    expect(token).toBeTruthy();

    // Token was bound to the web-UI origin; a different origin must not pair.
    const wrong = await pair(
      stack.urls.api,
      token as string,
      "https://attacker.example.com",
    );
    expect(wrong.status).toBe(401);

    // Missing Origin is rejected with 400 (route requires Origin).
    const noOrigin = await pair(stack.urls.api, token as string, null);
    expect(noOrigin.status).toBe(400);

    // And the (still-unused) token remains valid from the correct origin.
    const right = await pair(stack.urls.api, token as string, webUiOrigin);
    expect(right.status).toBe(200);
    expect(right.body.apiKey).toBeTruthy();
    expect(right.body.apiKey).not.toBe(AGENT_API_TOKEN);
    const claims = await verifyPairedSession(
      stack.urls.api,
      right.body.apiKey as string,
    );
    expect(claims).toMatchObject({
      userId: seededUser.userId,
      organizationId: seededUser.organizationId,
      agentId: sandboxId,
      sessionVersion: 1,
    });
  });

  test("rejects an expired pairing token", async ({ stack, seededUser }) => {
    const api = { apiUrl: stack.urls.api };
    const webUiOrigin = stack.urls.controlPlane;
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-pairing-expired",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      intervalMs: 250,
      onTick: processJobs,
    });

    // Insert an already-expired token row directly (mirrors the service's
    // hash + expected_origin shape) so we exercise the expiry branch of
    // consumeValidToken (expires_at > now is required).
    const token = plausiblePairingToken();
    const { agentPairingTokensRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-pairing-tokens"
    );
    await agentPairingTokensRepository.create({
      token_hash: hashToken(token),
      organization_id: seededUser.organizationId,
      user_id: seededUser.userId,
      agent_id: sandboxId,
      instance_url: `${webUiOrigin}/`,
      expected_origin: webUiOrigin,
      expires_at: new Date(Date.now() - 60_000),
    });

    const expired = await pair(stack.urls.api, token, webUiOrigin);
    expect(expired.status).toBe(401);
  });
});
