/**
 * Cache-only provisioning chat transport.
 *
 * The signed app JWT is verified locally, while cached authorization and
 * provisioning projections keep database work out of the Cerebras hot path.
 */

import { Hono } from "hono";
import { z } from "zod";
import { InsufficientCreditsError } from "@/lib/services/credits";
import {
  ElizaAppInferenceRateLimitError,
  ElizaAppInferenceWarmingError,
} from "@/lib/services/eliza-app/inference-hot-path";
import { resolveElizaAppInferenceSession } from "@/lib/services/eliza-app/inference-session-auth";
import {
  ProvisioningAgentChatWarmingError,
  provisioningAgentChat,
} from "@/lib/services/provisioning-agent-chat";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  agentId: z.string().uuid().optional(),
});

app.post("/", async (c) => {
  const auth = await resolveElizaAppInferenceSession(c.req.raw, c.executionCtx);
  if (auth.kind === "not_app_session") {
    return c.json(
      { error: "Authorization required", code: "UNAUTHORIZED" },
      401,
    );
  }
  if (auth.kind === "warming") {
    return c.json(
      {
        error: "Authorization cache is warming. Retry shortly.",
        code: "AUTH_CACHE_WARMING",
        retryable: true,
      },
      503,
      { "Retry-After": "1" },
    );
  }
  if (auth.kind === "rejected") {
    return c.json(
      {
        error:
          auth.status === 403
            ? "Account access is disabled"
            : "Invalid or expired session",
        code: auth.status === 403 ? "ACCESS_DISABLED" : "INVALID_SESSION",
      },
      auth.status,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", details: parsed.error.issues },
      400,
    );
  }

  try {
    const result = await provisioningAgentChat({
      identity: auth.identity,
      userMessage: parsed.data.message,
      agentId: parsed.data.agentId,
      requestId: crypto.randomUUID(),
      executionCtx: c.executionCtx,
    });

    const bridgeUrl = result.bridgeUrl ?? undefined;

    return c.json({
      success: true,
      data: {
        reply: result.reply,
        containerStatus: result.containerStatus,
        ...(bridgeUrl ? { bridgeUrl } : {}),
        agentId: result.agentId,
      },
    });
  } catch (err) {
    if (
      err instanceof ElizaAppInferenceWarmingError ||
      err instanceof ProvisioningAgentChatWarmingError
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
    if (err instanceof ElizaAppInferenceRateLimitError) {
      return c.json(
        {
          success: false,
          error: "Rate limit exceeded",
          code: "RATE_LIMITED",
          retryable: true,
        },
        429,
        { "Retry-After": String(err.retryAfter) },
      );
    }
    if (err instanceof InsufficientCreditsError) {
      return c.json(
        {
          success: false,
          error: "Insufficient balance",
          code: "INSUFFICIENT_CREDITS",
        },
        402,
      );
    }
    logger.error("[eliza-app provisioning-agent/chat] Error", { error: err });
    return c.json({ success: false, error: "Chat failed" }, 500);
  }
});

export default app;
