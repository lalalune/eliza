/**
 * Creates and releases an owner-only shared-runtime handoff fence.
 *
 * The snapshot POST waits until no model turn is admitted, then atomically
 * blocks later shared sends and returns the transcript plus activation state.
 * DELETE releases a failed attempt; a successful switch leaves the short lease
 * in place until the transient shared source is removed.
 */

import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  isCanonicalSharedRestConversation,
  releaseSharedRestHandoffFence,
  sharedRestHandoffSnapshot,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, DELETE, OPTIONS";
const HANDOFF_FENCE_LEASE_MS = 2 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const app = new Hono<AppEnv>();

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

async function resolveRequest(c: Parameters<typeof resolveSharedAgent>[0]) {
  const resolved = await resolveSharedAgent(c);
  if ("error" in resolved) return resolved;
  const conversationId = c.req.param("conversationId") ?? resolved.agentId;
  if (!isCanonicalSharedRestConversation(resolved.agentId, conversationId)) {
    return {
      error: "Conversation not found",
      status: 404 as const,
      code: "conversation_not_found",
    };
  }
  if (resolved.callerUserId !== resolved.agent.user_id) {
    return {
      error: "Only the agent owner can hand off this conversation",
      status: 403 as const,
      code: "owner_required",
    };
  }
  return { resolved, conversationId };
}

async function readFenceToken(
  c: Parameters<typeof resolveSharedAgent>[0],
): Promise<string | null> {
  const raw: unknown = await c.req.json().catch(() => null);
  const token =
    raw &&
    typeof raw === "object" &&
    typeof (raw as { fenceToken?: unknown }).fenceToken === "string"
      ? (raw as { fenceToken: string }).fenceToken.trim()
      : "";
  return UUID_PATTERN.test(token) ? token : null;
}

app.post("/", async (c) => {
  const origin = c.req.header("origin");
  const request = await resolveRequest(c);
  if ("error" in request) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: request.error,
          ...("code" in request ? { code: request.code } : {}),
        },
        { status: request.status },
      ),
      CORS_METHODS,
      origin,
    );
  }
  const fenceToken = await readFenceToken(c);
  if (!fenceToken) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "A valid fenceToken UUID is required",
          code: "invalid_fence_token",
        },
        { status: 400 },
      ),
      CORS_METHODS,
      origin,
    );
  }

  try {
    const snapshot = await sharedRestHandoffSnapshot({
      agentId: request.resolved.agentId,
      conversationId: request.conversationId,
      ownerUserId: request.resolved.agent.user_id,
      fenceToken,
      leaseMs: HANDOFF_FENCE_LEASE_MS,
    });
    if (!snapshot.ready) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "A shared conversation turn is still finishing",
            code: "handoff_not_quiescent",
            retryable: true,
            retryAfterMs: snapshot.retryAfterMs,
          },
          {
            status: 425,
            headers: {
              "Retry-After": String(
                Math.max(1, Math.ceil(snapshot.retryAfterMs / 1_000)),
              ),
            },
          },
        ),
        CORS_METHODS,
        origin,
      );
    }
    return applyCorsHeaders(
      Response.json({
        success: true,
        fenceToken,
        messages: snapshot.messages,
        ...(snapshot.activationGoal
          ? { activationGoal: snapshot.activationGoal }
          : {}),
      }),
      CORS_METHODS,
      origin,
    );
  } catch (error) {
    // error-policy:J1 route boundary translates snapshot failures.
    logger.warn("[shared-runtime handoff] snapshot failed", {
      agentId: request.resolved.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "The handoff snapshot is temporarily unavailable",
          code: "handoff_snapshot_unavailable",
          retryable: true,
        },
        { status: 503 },
      ),
      CORS_METHODS,
      origin,
    );
  }
});

app.delete("/", async (c) => {
  const origin = c.req.header("origin");
  const request = await resolveRequest(c);
  if ("error" in request) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: request.error,
          ...("code" in request ? { code: request.code } : {}),
        },
        { status: request.status },
      ),
      CORS_METHODS,
      origin,
    );
  }
  const fenceToken = await readFenceToken(c);
  if (!fenceToken) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "A valid fenceToken UUID is required",
          code: "invalid_fence_token",
        },
        { status: 400 },
      ),
      CORS_METHODS,
      origin,
    );
  }
  try {
    const released = await releaseSharedRestHandoffFence({
      agentId: request.resolved.agentId,
      conversationId: request.conversationId,
      fenceToken,
    });
    return applyCorsHeaders(
      Response.json({ success: true, released }),
      CORS_METHODS,
      origin,
    );
  } catch (error) {
    // error-policy:J1 route boundary translates fence-release failures.
    logger.warn("[shared-runtime handoff] fence release failed", {
      agentId: request.resolved.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "The handoff fence could not be released",
          code: "handoff_fence_release_failed",
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
