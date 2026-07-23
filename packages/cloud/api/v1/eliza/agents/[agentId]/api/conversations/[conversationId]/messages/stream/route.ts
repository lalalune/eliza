/**
 * Serves shared-agent conversation turns as Cloudflare-native SSE.
 *
 * Scope authorization and turn execution are cache-only on the response path;
 * cold hydration is scheduled under waitUntil and surfaced as retryable 503.
 */
import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  type CanonicalScopedStreamRequest,
  handleCanonicalScopedAgentStream,
} from "@/lib/services/shared-runtime/canonical-scoped-stream";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * /api/v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream
 *
 * SSE chat for a SHARED-runtime agent. The mobile/web chat client probes this
 * `/messages/stream` endpoint first (the agent-server REST conversation contract)
 * and only falls back to the non-stream `POST .../messages` if it 404s. A shared
 * agent runs in-Worker with no agent server, so there is no upstream SSE socket to
 * proxy — instead we run the SAME billed in-Worker turn the non-stream send uses
 * through the conversation Durable Object and emit its reply as SSE. The object
 * owns warm history and cache-only turn execution; cold authoritative hydration
 * is registered with waitUntil and reported as a retryable 503.
 *
 * The route returns the conversation coordinator's response body without
 * reading it, preserving incremental flushes from the Durable Object to the
 * Cloudflare edge.
 * Shared-tier + org-scoped (resolveSharedAgent gates auth, org-scope, tier).
 */
const CORS_METHODS = "POST, OPTIONS";

const app = new Hono<AppEnv>();

function nowMs(): number {
  return performance.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

async function resolveAgentScope(
  c: Parameters<typeof resolveSharedAgent>[0],
  executionCtx: BridgeExecutionContext,
) {
  return resolveSharedAgent(c, {
    cacheOnly: true,
    executionCtx,
  });
}

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.post("/", async (c) => {
  const origin = c.req.header("origin");
  const worker = resolveSharedRuntimeWorkerRequestContext(c);
  if ("error" in worker) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: worker.error,
          code: worker.code,
          retryable: worker.retryable,
        },
        { status: worker.status },
      ),
      CORS_METHODS,
      origin,
    );
  }
  const scopeStartedAt = nowMs();
  const scopePromise = resolveAgentScope(c, worker.executionCtx).then(
    (result) => ({
      result,
      durationMs: elapsedMs(scopeStartedAt),
    }),
  );
  const bodyStartedAt = nowMs();
  const bodyPromise = c.req
    .json()
    .catch(() => {
      // error-policy:J3 untrusted-input sanitizing. Match the canonical stream
      // contract: malformed JSON is an invalid request body, not a fabricated
      // successful turn.
      return {};
    })
    .then((body: unknown) => ({
      body,
      durationMs: elapsedMs(bodyStartedAt),
    }));

  const [
    { result: r, durationMs: scopeMs },
    { body: raw, durationMs: bodyMs },
  ] = await Promise.all([scopePromise, bodyPromise]);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: r.error,
          ...("code" in r ? { code: r.code } : {}),
          ...(r.status === 503 ? { retryable: true } : {}),
        },
        { status: r.status },
      ),
      CORS_METHODS,
      origin,
    );
  }

  const conversationId = c.req.param("conversationId") ?? r.agentId;
  return handleCanonicalScopedAgentStream({
    agent: r.agent,
    agentId: r.agentId,
    orgId: r.orgId,
    conversationId,
    ...(r.authorization ? { authorization: r.authorization } : {}),
    body: raw,
    origin,
    namespace: worker.namespace,
    // The Worker context carries both cold hydration and the shared turn's
    // deferred billing tail without putting either on the response path.
    executionCtx: worker.executionCtx,
    timings: {
      scope: scopeMs,
      body: bodyMs,
    },
  } satisfies CanonicalScopedStreamRequest);
});

export default app;
