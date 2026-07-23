/**
 * Durable greeting endpoint for shared-runtime Cloud agents.
 *
 * Ordinary greetings remain per-room and seed only an empty conversation.
 * Post-sign-in activation is owner-only and uses the Cloud activation ledger,
 * so retries, reloads, and concurrent requests across rooms return one message.
 */

import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  isCanonicalSharedRestConversation,
  POST_SIGN_IN_ACTIVATION_KIND,
  sharedRestConversationGreeting,
  sharedRestPostSignInActivation,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

const app = new Hono<AppEnv>();

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.post("/", async (c) => {
  const origin = c.req.header("origin");
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
      origin,
    );
  }

  const conversationId = c.req.param("conversationId") ?? r.agentId;
  if (!isCanonicalSharedRestConversation(r.agentId, conversationId)) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "Conversation not found",
          code: "conversation_not_found",
        },
        { status: 404 },
      ),
      CORS_METHODS,
      origin,
    );
  }
  const requestedKind = c.req.query("greetingKind")?.trim();
  if (
    requestedKind !== undefined &&
    requestedKind !== "" &&
    requestedKind !== "conversation" &&
    requestedKind !== POST_SIGN_IN_ACTIVATION_KIND
  ) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "Unsupported greeting kind",
          code: "invalid_greeting_kind",
        },
        { status: 400 },
      ),
      CORS_METHODS,
      origin,
    );
  }

  try {
    if (requestedKind === POST_SIGN_IN_ACTIVATION_KIND) {
      if (r.callerUserId !== r.agent.user_id) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: "Only the agent owner can request post-sign-in activation",
              code: "owner_required",
            },
            { status: 403 },
          ),
          CORS_METHODS,
          origin,
        );
      }
      const activation = await sharedRestPostSignInActivation(
        r.agentId,
        r.agent.user_id,
        conversationId,
        r.agentName,
      );
      return applyCorsHeaders(Response.json(activation), CORS_METHODS, origin);
    }

    const greeting = await sharedRestConversationGreeting(
      r.agentId,
      conversationId,
      r.agentName,
    );
    return applyCorsHeaders(Response.json(greeting), CORS_METHODS, origin);
  } catch (error) {
    // error-policy:J1 The Worker route is the HTTP boundary for durable
    // greeting storage; database failures remain observable and never fabricate
    // a greeting that was not committed.
    logger.error("[shared-runtime REST] greeting persistence failed", {
      agentId: r.agentId,
      greetingKind: requestedKind || "conversation",
      error: error instanceof Error ? error.message : String(error),
    });
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "The greeting could not be stored. Please try again.",
          code: "greeting_persistence_failed",
          retryable: true,
        },
        { status: 503 },
      ),
      CORS_METHODS,
      origin,
    );
  }
});

export default app;
