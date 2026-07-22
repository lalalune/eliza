/**
 * Verifies that pairing exchanges a one-time code for a scoped browser
 * session and never returns the dedicated container's shared API token.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as agentSandboxesActual from "@/db/repositories/agent-sandboxes";
import * as usersActual from "@/db/repositories/users";
import * as dedicatedSessionActual from "@/lib/auth/dedicated-agent-session";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as pairingTokenActual from "@/lib/services/pairing-token";
import * as loggerActual from "@/lib/utils/logger";

const pairingScope = {
  userId: "user-1",
  orgId: "org-1",
  agentId: "agent-1",
  instanceUrl: "https://agent-1.elizacloud.ai",
  expectedOrigin: "https://agent-1.elizacloud.ai",
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
};
const inspectToken = mock(async () => pairingScope);
const validateToken = mock(async () => pairingScope);
const findByIdAndOrg = mock(async () => ({
  id: "agent-1",
  agent_name: "Paired Agent",
  environment_vars: { ELIZA_API_TOKEN: "container-shared-secret" },
}));
const findUserWithOrganization = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
  is_active: true,
  deleted_at: null,
  organization: { id: "org-1", is_active: true },
}));
const mintDedicatedAgentSession = mock(async () => ({
  token: "scoped-browser-session",
  expiresAt: "2030-01-01T00:00:00.000Z",
}));
let signingReadiness:
  | { ready: true }
  | { ready: false; code: "not_configured" | "invalid_configuration" } = {
  ready: true,
};
const validateDedicatedAgentSessionSigningConfig = mock(
  async () => signingReadiness,
);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  ...agentSandboxesActual,
  agentSandboxesRepository: {
    ...agentSandboxesActual.agentSandboxesRepository,
    findByIdAndOrg,
  },
}));
mock.module("@/db/repositories/users", () => ({
  ...usersActual,
  usersRepository: {
    ...usersActual.usersRepository,
    findWithOrganization: findUserWithOrganization,
  },
}));
mock.module("@/lib/auth/dedicated-agent-session", () => ({
  ...dedicatedSessionActual,
  mintDedicatedAgentSession,
  validateDedicatedAgentSessionSigningConfig,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  rateLimit: () => async (_ctx: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
mock.module("@/lib/services/pairing-token", () => ({
  ...pairingTokenActual,
  getPairingTokenService: () => ({ inspectToken, validateToken }),
}));
mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: { ...loggerActual.logger, error: mock(() => undefined) },
}));

const { default: pairRoute } = await import("../auth/pair/route");

afterAll(() => {
  mock.module("@/db/repositories/agent-sandboxes", () => agentSandboxesActual);
  mock.module("@/db/repositories/users", () => usersActual);
  mock.module(
    "@/lib/auth/dedicated-agent-session",
    () => dedicatedSessionActual,
  );
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/services/pairing-token", () => pairingTokenActual);
  mock.module("@/lib/utils/logger", () => loggerActual);
});

beforeEach(() => {
  inspectToken.mockClear();
  validateToken.mockClear();
  findByIdAndOrg.mockClear();
  findUserWithOrganization.mockClear();
  mintDedicatedAgentSession.mockClear();
  validateDedicatedAgentSessionSigningConfig.mockClear();
  signingReadiness = { ready: true };
});

describe("POST /auth/pair scoped session", () => {
  test("binds the paired browser to user, organization, and agent claims", async () => {
    const response = await pairRoute.request(
      "http://cloud.test/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://agent-1.elizacloud.ai",
        },
        body: JSON.stringify({ token: "a".repeat(43) }),
      },
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "staging.elizacloud.ai" },
    );

    expect(response.status).toBe(200);
    expect(validateDedicatedAgentSessionSigningConfig).toHaveBeenCalledTimes(1);
    expect(inspectToken).toHaveBeenCalledWith(
      "a".repeat(43),
      "https://agent-1.elizacloud.ai",
    );
    expect(validateToken).toHaveBeenCalledWith(
      "a".repeat(43),
      "https://agent-1.elizacloud.ai",
    );
    expect(findByIdAndOrg).toHaveBeenCalledWith("agent-1", "org-1");
    expect(findUserWithOrganization).toHaveBeenCalledWith("user-1");
    expect(mintDedicatedAgentSession).toHaveBeenCalledWith(
      {
        userId: "user-1",
        organizationId: "org-1",
        agentId: "agent-1",
      },
      {
        issuer: "https://staging.elizacloud.ai/dedicated-agent-session",
      },
    );
    expect((await response.json()) as unknown).toEqual({
      message: "Paired successfully",
      apiKey: "scoped-browser-session",
      expiresAt: "2030-01-01T00:00:00.000Z",
      agentName: "Paired Agent",
    });
    expect(response.headers.get("cache-control")).toBe(
      "no-store, no-cache, must-revalidate",
    );
  });

  test("returns a retryable 503 without consuming the code when signing keys are missing", async () => {
    signingReadiness = { ready: false, code: "not_configured" };

    const response = await pairRoute.request(
      "http://cloud.test/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://agent-1.elizacloud.ai",
        },
        body: JSON.stringify({ token: "a".repeat(43) }),
      },
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      error: "Secure pairing is temporarily unavailable",
      code: "pairing_session_signing_unavailable",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(inspectToken).not.toHaveBeenCalled();
    expect(validateToken).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(findUserWithOrganization).not.toHaveBeenCalled();
    expect(mintDedicatedAgentSession).not.toHaveBeenCalled();
  });

  test("returns a retryable 503 without consuming the code when signing keys are malformed", async () => {
    signingReadiness = { ready: false, code: "invalid_configuration" };

    const response = await pairRoute.request(
      "http://cloud.test/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://agent-1.elizacloud.ai",
        },
        body: JSON.stringify({ token: "a".repeat(43) }),
      },
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      error: "Secure pairing is temporarily unavailable",
      code: "pairing_session_signing_unavailable",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(inspectToken).not.toHaveBeenCalled();
    expect(validateToken).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(findUserWithOrganization).not.toHaveBeenCalled();
    expect(mintDedicatedAgentSession).not.toHaveBeenCalled();
  });

  test("returns a retryable 503 without consuming the code when the session issuer is invalid", async () => {
    const response = await pairRoute.request(
      "http://cloud.test/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://agent-1.elizacloud.ai",
        },
        body: JSON.stringify({ token: "a".repeat(43) }),
      },
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "invalid domain" },
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      error: "Secure pairing is temporarily unavailable",
      code: "pairing_session_configuration_unavailable",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(validateDedicatedAgentSessionSigningConfig).not.toHaveBeenCalled();
    expect(inspectToken).not.toHaveBeenCalled();
    expect(validateToken).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(findUserWithOrganization).not.toHaveBeenCalled();
    expect(mintDedicatedAgentSession).not.toHaveBeenCalled();
  });

  test("rejects a pairing code after the user loses organization membership", async () => {
    findUserWithOrganization.mockImplementationOnce(async () => ({
      id: "user-1",
      organization_id: "other-org",
      is_active: true,
      deleted_at: null,
      organization: { id: "other-org", is_active: true },
    }));
    const response = await pairRoute.request(
      "http://cloud.test/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://agent-1.elizacloud.ai",
        },
        body: JSON.stringify({ token: "a".repeat(43) }),
      },
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response.status).toBe(401);
    expect((await response.json()) as unknown).toEqual({
      error: "Pairing membership is no longer active",
    });
    expect(validateToken).not.toHaveBeenCalled();
    expect(mintDedicatedAgentSession).not.toHaveBeenCalled();
  });

  test("rejects an inactive organization without consuming the one-time code", async () => {
    findUserWithOrganization.mockImplementationOnce(async () => ({
      id: "user-1",
      organization_id: "org-1",
      is_active: true,
      deleted_at: null,
      organization: { id: "org-1", is_active: false },
    }));

    const response = await pairRoute.request(
      "http://cloud.test/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://agent-1.elizacloud.ai",
        },
        body: JSON.stringify({ token: "a".repeat(43) }),
      },
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response.status).toBe(401);
    expect((await response.json()) as unknown).toEqual({
      error: "Pairing membership is no longer active",
    });
    expect(inspectToken).toHaveBeenCalledTimes(1);
    expect(validateToken).not.toHaveBeenCalled();
    expect(mintDedicatedAgentSession).not.toHaveBeenCalled();
  });
});
