/**
 * GET /api/v1/hf-proxy/[...path]
 *
 * Authenticated, server-side HuggingFace download proxy. Devices never hold a
 * local HuggingFace token: when linked to Eliza Cloud they route every gated
 * eliza-1 bundle `resolve` request through here, and the cloud attaches its own
 * `HF_TOKEN` so gated repos download without exposing a key to the client.
 *
 * The catch-all path is the exact HuggingFace `resolve` suffix the client built
 * (`<repo>/resolve/<rev>/<file>`), so the upstream URL is reconstructed 1:1 and
 * the body is streamed back unbuffered, preserving the headers a resumable
 * downloader depends on (content-length, content-range, accept-ranges, etag,
 * content-type). `Range` is forwarded so 206 partial-content resume works.
 *
 * SECURITY: only paths containing a `/resolve/` segment on huggingface.co are
 * forwarded — the route never proxies an arbitrary host or path, and the
 * upstream host is fixed (no client-controlled hostname), so it cannot be used
 * as an open SSRF relay.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const HF_UPSTREAM_HOST = "https://huggingface.co";
const DEFAULT_MONTHLY_EGRESS_LIMIT_BYTES = 500 * 1024 ** 3;
const MONTHLY_EGRESS_TTL_SECONDS = 35 * 24 * 60 * 60;

/** Response headers worth preserving for a resumable streaming download. */
const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "content-disposition",
] as const;

const app = new Hono<AppEnv>();

interface EgressCounter {
  bytes: number;
  expiresAt: number;
}

const inMemoryEgressCounters = new Map<string, EgressCounter>();

function monthlyEgressLimitBytes(env: AppEnv["Bindings"]): number {
  const raw = env.HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES;
  const parsed =
    typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MONTHLY_EGRESS_LIMIT_BYTES;
}

function monthBucket(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function egressKey(organizationId: string, now = new Date()): string {
  return `hf-proxy:egress:${organizationId}:${monthBucket(now)}`;
}

async function readMonthlyEgress(
  env: AppEnv["Bindings"],
  organizationId: string,
): Promise<number> {
  const key = egressKey(organizationId);
  const kv = env.CACHE_KV;
  if (kv) {
    const raw = await kv.get(key);
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw) as { bytes?: unknown };
      return typeof parsed.bytes === "number" ? parsed.bytes : 0;
    } catch {
      return 0;
    }
  }

  const now = Date.now();
  const counter = inMemoryEgressCounters.get(key);
  if (!counter || counter.expiresAt <= now) {
    inMemoryEgressCounters.delete(key);
    return 0;
  }
  return counter.bytes;
}

async function addMonthlyEgress(
  env: AppEnv["Bindings"],
  organizationId: string,
  bytes: number,
): Promise<number> {
  if (bytes <= 0) return readMonthlyEgress(env, organizationId);

  const key = egressKey(organizationId);
  const kv = env.CACHE_KV;
  const current = await readMonthlyEgress(env, organizationId);
  const next = current + bytes;
  const value = JSON.stringify({
    bytes: next,
    updatedAt: new Date().toISOString(),
  });
  if (kv) {
    await kv.put(key, value, { expirationTtl: MONTHLY_EGRESS_TTL_SECONDS });
  } else {
    inMemoryEgressCounters.set(key, {
      bytes: next,
      expiresAt: Date.now() + MONTHLY_EGRESS_TTL_SECONDS * 1000,
    });
  }
  return next;
}

function parseContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function repoFromResolvePath(path: string): string {
  const resolveIndex = path.indexOf("/resolve/");
  const repo = resolveIndex >= 0 ? path.slice(0, resolveIndex) : path;
  return repo.split("/").slice(0, 2).join("/");
}

function cacheStatus(headers: Headers): string | null {
  return headers.get("cf-cache-status") ?? headers.get("x-cache") ?? null;
}

function cacheHit(value: string | null): boolean | null {
  if (!value) return null;
  return /\bhit\b/i.test(value);
}

function egressLimitResponse(
  organizationId: string,
  limitBytes: number,
  usedBytes: number,
) {
  return {
    error: "HuggingFace proxy monthly egress budget exceeded.",
    code: "HF_PROXY_EGRESS_LIMIT",
    organization_id: organizationId,
    limit_bytes: limitBytes,
    used_bytes: usedBytes,
  };
}

function streamWithEgressAccounting(args: {
  body: ReadableStream<Uint8Array>;
  env: AppEnv["Bindings"];
  organizationId: string;
  repo: string;
  path: string;
  status: number;
  cacheStatus: string | null;
}): ReadableStream<Uint8Array> {
  let bytes = 0;
  return args.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      async flush() {
        const record = addMonthlyEgress(
          args.env,
          args.organizationId,
          bytes,
        ).then((usedBytes) => {
          logger.info("[hf-proxy] egress metric", {
            organizationId: args.organizationId,
            repo: args.repo,
            path: args.path,
            bytes,
            status: args.status,
            cacheStatus: args.cacheStatus,
            cacheHit: cacheHit(args.cacheStatus),
            usedBytes,
          });
        });
        await record;
      },
    }),
  );
}

app.get("/*", async (c) => {
  try {
    // Auth: a real cloud session or org API key. We do not act on the user
    // beyond requiring a valid linked account — the value is the cloud-side
    // HF_TOKEN, not per-user scoping.
    const auth = await requireUserOrApiKeyWithOrg(c);
    const organizationId = auth.organization_id;
    if (!organizationId) {
      return c.json({ error: "Organization is required." }, 403);
    }

    const hfToken = c.env.HF_TOKEN?.trim();
    if (!hfToken) {
      logger.error("[hf-proxy] HF_TOKEN binding is not configured");
      return c.json(
        { error: "HuggingFace proxy is not configured on this deployment." },
        503,
      );
    }

    const path = (c.req.param("*") ?? "").replace(/^\/+/, "");
    // Only forward genuine HuggingFace download paths.
    if (!path.includes("/resolve/")) {
      return c.json(
        { error: "Only HuggingFace resolve paths are proxied." },
        400,
      );
    }
    const repo = repoFromResolvePath(path);
    const limitBytes = monthlyEgressLimitBytes(c.env);
    const usedBytes = await readMonthlyEgress(c.env, organizationId);
    if (usedBytes >= limitBytes) {
      return c.json(
        egressLimitResponse(organizationId, limitBytes, usedBytes),
        429,
      );
    }

    const incomingUrl = new URL(c.req.url);
    const upstream = new URL(`${HF_UPSTREAM_HOST}/${path}`);
    // Preserve the original query (e.g. ?download=true) verbatim.
    upstream.search = incomingUrl.search;

    const headers = new Headers();
    headers.set("authorization", `Bearer ${hfToken}`);
    headers.set("user-agent", "ElizaCloud-HfProxy/1.0");
    const range = c.req.header("range");
    if (range) headers.set("range", range);

    const upstreamResponse = await fetch(upstream, {
      method: "GET",
      headers,
      redirect: "follow",
    });

    if (upstreamResponse.status >= 400) {
      logger.warn("[hf-proxy] upstream HuggingFace error", {
        path,
        status: upstreamResponse.status,
      });
    }

    if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
      const upstreamCacheStatus = cacheStatus(upstreamResponse.headers);
      logger.info("[hf-proxy] egress metric", {
        organizationId,
        repo,
        path,
        bytes: 0,
        status: upstreamResponse.status,
        cacheStatus: upstreamCacheStatus,
        cacheHit: cacheHit(upstreamCacheStatus),
        usedBytes,
      });
      return c.json(
        {
          error: "HuggingFace repo is gated or unauthorized.",
          code: "HF_GATED",
          repo,
        },
        upstreamResponse.status,
      );
    }

    const contentLength = parseContentLength(upstreamResponse.headers);
    if (contentLength !== null && usedBytes + contentLength > limitBytes) {
      return c.json(
        egressLimitResponse(organizationId, limitBytes, usedBytes),
        429,
      );
    }

    const responseHeaders = new Headers();
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    const body = upstreamResponse.body
      ? streamWithEgressAccounting({
          body: upstreamResponse.body,
          env: c.env,
          organizationId,
          repo,
          path,
          status: upstreamResponse.status,
          cacheStatus: cacheStatus(upstreamResponse.headers),
        })
      : null;

    // Stream the body straight through — never buffer a multi-GB GGUF.
    return new Response(body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
