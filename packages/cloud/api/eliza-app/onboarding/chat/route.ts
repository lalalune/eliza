/**
 * POST /api/eliza-app/onboarding/chat
 *
 * Public chat-first onboarding endpoint. Anonymous users get a persistent
 * onboarding session and login action; authenticated users trigger agent
 * provisioning and handoff memory copy.
 */

import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { InsufficientCreditsError } from "@/lib/services/credits";
import {
  ElizaAppInferenceRateLimitError,
  ElizaAppInferenceWarmingError,
} from "@/lib/services/eliza-app/inference-hot-path";
import {
  type ElizaAppInferenceIdentity,
  resolveElizaAppInferenceSession,
} from "@/lib/services/eliza-app/inference-session-auth";
import {
  OnboardingChatWarmingError,
  type OnboardingPlatform,
  runOnboardingChat,
} from "@/lib/services/eliza-app/onboarding-chat";
import { publicElizaAppProvisioningPayload } from "@/lib/services/eliza-app/provisioning";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../internal/_auth";

const app = new Hono<AppEnv>();

const platformSchema = z.enum([
  "web",
  "telegram",
  "discord",
  "whatsapp",
  "twilio",
  "blooio",
]);

const chatSchema = z.object({
  sessionId: z.string().trim().min(8).max(180).optional(),
  message: z.string().trim().max(4000).optional(),
  platform: platformSchema.optional(),
  platformUserId: z.string().trim().max(256).optional(),
  platformDisplayName: z.string().trim().max(120).optional(),
});

async function resolveCaller(c: Context<AppEnv>): Promise<{
  authenticatedUser: { userId: string; organizationId: string } | null;
  inferenceIdentity?: ElizaAppInferenceIdentity;
  trustedPlatformIdentity: boolean;
  rejectedStatus?: 401 | 403;
  warming?: boolean;
}> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return { authenticatedUser: null, trustedPlatformIdentity: false };
  }

  const session = await resolveElizaAppInferenceSession(
    c.req.raw,
    c.executionCtx,
  );
  if (session.kind === "authorized") {
    return {
      authenticatedUser: {
        userId: session.identity.userId,
        organizationId: session.identity.organizationId,
      },
      inferenceIdentity: session.identity,
      trustedPlatformIdentity: false,
    };
  }
  if (session.kind === "warming") {
    return {
      authenticatedUser: null,
      trustedPlatformIdentity: false,
      warming: true,
    };
  }

  const internal = await requireInternalAuth(c);
  if (internal instanceof Response) {
    return {
      authenticatedUser: null,
      trustedPlatformIdentity: false,
      rejectedStatus: session.kind === "rejected" ? session.status : 401,
    };
  }

  return { authenticatedUser: null, trustedPlatformIdentity: true };
}

app.post("/", async (c) => {
  try {
    const body = await c.req.json().catch(() => {
      throw ValidationError("Invalid JSON body");
    });
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) {
      throw ValidationError("Invalid request data", {
        issues: parsed.error.issues,
      });
    }

    const caller = await resolveCaller(c);
    if (caller.warming) {
      return c.json(
        {
          success: false,
          error: "Authorization cache is warming. Retry shortly.",
          code: "AUTH_CACHE_WARMING",
          retryable: true,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    if (caller.rejectedStatus) {
      return c.json(
        {
          success: false,
          error:
            caller.rejectedStatus === 403
              ? "Account access is disabled"
              : "Invalid or expired session",
          code:
            caller.rejectedStatus === 403
              ? "ACCESS_DISABLED"
              : "INVALID_SESSION",
        },
        caller.rejectedStatus,
      );
    }
    const result = await runOnboardingChat(
      {
        sessionId: parsed.data.sessionId,
        message: parsed.data.message,
        platform: parsed.data.platform as OnboardingPlatform | undefined,
        platformUserId: parsed.data.platformUserId,
        platformDisplayName: parsed.data.platformDisplayName,
        authenticatedUser: caller.authenticatedUser,
        trustedPlatformIdentity: caller.trustedPlatformIdentity,
      },
      {
        executionCtx: c.executionCtx,
        identity: caller.inferenceIdentity,
        requestId: crypto.randomUUID(),
      },
    );

    return c.json({
      success: true,
      data: {
        sessionId: result.session.id,
        reply: result.reply,
        requiresLogin: result.requiresLogin,
        loginUrl: result.loginUrl,
        controlPanelUrl: result.controlPanelUrl,
        launchUrl: result.launchUrl,
        handoffComplete: result.handoffComplete,
        provisioning: publicElizaAppProvisioningPayload(result.provisioning),
        messages: result.session.history,
      },
    });
  } catch (error) {
    if (
      error instanceof ElizaAppInferenceWarmingError ||
      error instanceof OnboardingChatWarmingError
    ) {
      return c.json(
        {
          success: false,
          error: "Inference state is warming. Retry shortly.",
          code: "INFERENCE_CACHE_WARMING",
          retryable: true,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    if (error instanceof ElizaAppInferenceRateLimitError) {
      return c.json(
        {
          success: false,
          error: "Rate limit exceeded",
          code: "RATE_LIMITED",
          retryable: true,
        },
        429,
        { "Retry-After": String(error.retryAfter) },
      );
    }
    if (error instanceof InsufficientCreditsError) {
      return c.json(
        {
          success: false,
          error: "Insufficient balance",
          code: "INSUFFICIENT_CREDITS",
        },
        402,
      );
    }
    logger.error("[eliza-app onboarding/chat] Error", { error });
    return failureResponse(c, error);
  }
});

export default app;
