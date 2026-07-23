/**
 * Ends the current Steward session at both the browser and inference boundary.
 *
 * Strong inference revocation commits before browser cookies are deleted. A
 * retryable failure therefore leaves the credential available for another
 * logout attempt instead of destroying the only copy while a replay remains
 * authorized.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { revokeStewardRefreshToken } from "@/api/auth/steward-refresh-token-revocation";
import { invalidateSessionCaches } from "@/lib/auth";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import {
  canMutateLegacyStewardCookies,
  LEGACY_STEWARD_COOKIES,
  stewardCookieNames,
} from "@/lib/auth/steward-cookies";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { revokeInferenceStewardSession } from "@/lib/services/inference-session-revocation";
import { userSessionsService } from "@/lib/services/user-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  const cookieNames = stewardCookieNames(c.env.ENVIRONMENT);
  const canMutateLegacy = canMutateLegacyStewardCookies(c.env.ENVIRONMENT);
  const authorization = c.req.header("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim() || null
    : null;
  const isApiKeyRequest = bearer?.startsWith("eliza_") === true;

  // API-key auth owns the request and cannot authorize mutation of an unrelated
  // browser session. Leaving cookies untouched also preserves their credential
  // for a subsequent Steward-authenticated logout.
  if (isApiKeyRequest) {
    return c.json({ success: true, message: "Logged out successfully" });
  }

  const cookieToken =
    getCookie(c, cookieNames.token) ??
    (canMutateLegacy ? getCookie(c, LEGACY_STEWARD_COOKIES.token) : undefined);
  const refreshToken =
    getCookie(c, cookieNames.refreshToken) ??
    (canMutateLegacy
      ? getCookie(c, LEGACY_STEWARD_COOKIES.refreshToken)
      : undefined);
  const accessTokens = [
    ...new Set(
      [bearer, cookieToken].filter(
        (token): token is string => typeof token === "string" && token.length > 0,
      ),
    ),
  ];
  if (
    accessTokens.length > 0 &&
    !c.env.STEWARD_SESSION_SECRET &&
    !c.env.STEWARD_JWT_SECRET
  ) {
    return c.json(
      {
        success: false,
        error: "Server-side session revocation is not configured",
      },
      503,
    );
  }

  for (const token of accessTokens) {
    try {
      const revoked = await revokeInferenceStewardSession(token, {
        STEWARD_SESSION_SECRET: c.env.STEWARD_SESSION_SECRET,
        STEWARD_JWT_SECRET: c.env.STEWARD_JWT_SECRET,
        STEWARD_TENANT_ID: c.env.STEWARD_TENANT_ID,
      });
      if (!revoked && token === bearer) {
        return c.json(
          { success: false, error: "Invalid Steward bearer token" },
          401,
        );
      }
    } catch (error) {
      // error-policy:J1 exact revocation is the logout security boundary. A
      // retryable failure keeps browser credentials intact for another attempt.
      logger.error("[Logout] Durable session revocation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          success: false,
          error:
            "Server-side session revocation did not complete; retry logout",
        },
        503,
      );
    }
  }

  if (refreshToken) {
    try {
      await revokeStewardRefreshToken(refreshToken, c.env);
    } catch (error) {
      // error-policy:J1 a copied refresh token can mint a new access credential,
      // so local cookie deletion must wait for authoritative upstream revoke.
      logger.error("[Logout] Steward refresh revocation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          success: false,
          error: "Refresh-session revocation did not complete; retry logout",
        },
        503,
      );
    }
  }

  const domain = cookieDomainForHost(c.req.header("host"));
  const stewardOpts = domain ? { path: "/", domain } : { path: "/" };
  // Non-production clears only its suffixed pair. The unsuffixed legacy names
  // are production's live cookies on the shared parent domain.
  deleteCookie(c, cookieNames.token, stewardOpts);
  deleteCookie(c, cookieNames.refreshToken, stewardOpts);
  deleteCookie(c, cookieNames.authed, stewardOpts);
  if (canMutateLegacy) {
    deleteCookie(c, LEGACY_STEWARD_COOKIES.token, stewardOpts);
    deleteCookie(c, LEGACY_STEWARD_COOKIES.refreshToken, stewardOpts);
    deleteCookie(c, LEGACY_STEWARD_COOKIES.authed, stewardOpts);
  }
  deleteCookie(c, "eliza-anon-session", { path: "/" });

  try {
    for (const token of accessTokens) {
      await invalidateSessionCaches(token);
    }
    if (accessTokens.length > 0) {
      logger.debug("[Logout] Invalidated session caches for tokens");
    }

    const user = accessTokens.length > 0 ? await getCurrentUser(c) : null;
    if (user) {
      await userSessionsService.endAllUserSessions(user.id);
      await getAuditDispatcher()
        .emit({
          actor: { type: "user", id: user.id },
          action: "auth.logout",
          result: "success",
          resource: null,
          org_id: user.organization_id ?? undefined,
          ip:
            c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
          user_agent: c.req.header("user-agent") ?? undefined,
          request_id: c.get("requestId"),
          metadata: { method: "steward_session" },
        })
        // error-policy:J7 audit write is diagnostic; logout already succeeded via
        // the cookie clear above, so a dropped audit event is logged, not fatal.
        .catch((err: unknown) => {
          logger.warn("[Logout] audit emit failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  } catch (error) {
    // error-policy:J6 best-effort teardown — cookies are already cleared, so the
    // user is logged out client-side; a failed server-side session teardown must
    // not turn logout into a 500 that strands stale cookies. Caches expire on TTL.
    logger.warn(
      "[Logout] server-side teardown failed (cookies already cleared)",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return c.json({ success: true, message: "Logged out successfully" });
});

export default app;
