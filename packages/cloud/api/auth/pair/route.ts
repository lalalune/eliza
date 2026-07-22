/**
 * POST /api/auth/pair
 *
 * Validates a one-time pairing token and returns a user- and agent-scoped
 * session so pair.html can bootstrap the web UI without exposing container
 * credentials.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { usersRepository } from "@/db/repositories/users";
import {
  dedicatedAgentSessionIssuerFromEnvironment,
  mintDedicatedAgentSession,
  validateDedicatedAgentSessionSigningConfig,
} from "@/lib/auth/dedicated-agent-session";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getPairingTokenService } from "@/lib/services/pairing-token";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

function isPlausiblePairingToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function isSamePairingScope(
  inspected: {
    userId: string;
    orgId: string;
    agentId: string;
  },
  consumed: {
    userId: string;
    orgId: string;
    agentId: string;
  },
): boolean {
  return (
    inspected.userId === consumed.userId &&
    inspected.orgId === consumed.orgId &&
    inspected.agentId === consumed.agentId
  );
}

app.post("/", async (c) => {
  try {
    // error-policy:J3 malformed untrusted JSON is an explicit invalid request,
    // never a partially trusted pairing payload.
    const body = (await c.req.json().catch(() => null)) as {
      token?: string;
    } | null;
    const token = body?.token;

    if (!token) {
      return c.json({ error: "Pairing code required" }, 400);
    }

    const origin = c.req.header("origin") ?? null;
    if (!origin) {
      return c.json({ error: "Origin header required" }, 400);
    }

    if (!isPlausiblePairingToken(token)) {
      return c.json({ error: "Invalid or expired pairing code" }, 401);
    }

    let sessionIssuer: string;
    try {
      sessionIssuer = dedicatedAgentSessionIssuerFromEnvironment(c.env);
    } catch {
      // error-policy:J1 the HTTP boundary converts invalid deployment routing
      // config into a retryable failure before the one-time code is consumed.
      logger.error("[auth/pair] dedicated session issuer is invalid");
      return c.json(
        {
          error: "Secure pairing is temporarily unavailable",
          code: "pairing_session_configuration_unavailable",
        },
        503,
        { "Cache-Control": "no-store", "Retry-After": "5" },
      );
    }

    const signingReadiness = await validateDedicatedAgentSessionSigningConfig();
    if (!signingReadiness.ready) {
      logger.error("[auth/pair] dedicated session signing is unavailable", {
        code: signingReadiness.code,
      });
      return c.json(
        {
          error: "Secure pairing is temporarily unavailable",
          code: "pairing_session_signing_unavailable",
        },
        503,
        { "Cache-Control": "no-store", "Retry-After": "5" },
      );
    }

    const tokenService = getPairingTokenService();
    // Inspect first so account/org eligibility failures do not burn the
    // one-time code. validateToken below remains the atomic consume boundary.
    const pairingToken = await tokenService.inspectToken(token, origin);
    if (!pairingToken) {
      return c.json({ error: "Invalid or expired pairing code" }, 401);
    }

    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      pairingToken.agentId,
      pairingToken.orgId,
    );
    if (!sandbox) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const user = await usersRepository.findWithOrganization(
      pairingToken.userId,
    );
    if (!user) {
      return c.json({ error: "Pairing membership is no longer active" }, 401);
    }
    const organization = user.organization;
    if (
      !user.is_active ||
      user.deleted_at ||
      user.organization_id !== pairingToken.orgId ||
      !organization ||
      organization.id !== pairingToken.orgId ||
      !organization.is_active
    ) {
      return c.json({ error: "Pairing membership is no longer active" }, 401);
    }

    const consumedToken = await tokenService.validateToken(token, origin);
    if (!consumedToken || !isSamePairingScope(pairingToken, consumedToken)) {
      return c.json({ error: "Invalid or expired pairing code" }, 401);
    }

    const session = await mintDedicatedAgentSession(
      {
        userId: consumedToken.userId,
        organizationId: consumedToken.orgId,
        agentId: consumedToken.agentId,
      },
      {
        issuer: sessionIssuer,
      },
    );

    return c.json(
      {
        message: "Paired successfully",
        // Keep the response field stable for existing clients. Its value is a
        // scoped edge session, never the shared container API token.
        apiKey: session.token,
        expiresAt: session.expiresAt,
        agentName: sandbox.agent_name ?? "Agent",
      },
      200,
      { "Cache-Control": "no-store, no-cache, must-revalidate" },
    );
  } catch (err) {
    // error-policy:J1 the pairing HTTP boundary emits one generic failure and
    // keeps internal token, membership, and signing details out of the client.
    logger.error("[auth/pair] error", { error: err });
    return c.json({ error: "Pairing failed" }, 500);
  }
});

export default app;
