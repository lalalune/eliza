/**
 * App-scoped chat through cache authorization and serialized inference admission.
 *
 * Warm Worker requests read credential, app policy, pricing, and balance state
 * only from cache before the per-organization Durable Object authorizes provider
 * dispatch. Durable app accounting continues under `waitUntil`.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  nextStyleParams,
  type RouteContext,
} from "@/lib/api/hono-next-style-params";
import { isCrossAppKeyUsage } from "@/lib/auth/app-key-scope";
import {
  addCorsHeaders,
  createPreflightResponse,
} from "@/lib/middleware/cors-apps";
import {
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError,
} from "@/lib/middleware/rate-limit";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "@/lib/pricing";
import {
  getProviderForModelWithFallback,
  withProviderFallback,
} from "@/lib/providers";
import {
  canonicalizeCerebrasModelId,
  getAiProviderConfigurationError,
  hasLanguageModelProviderConfigured,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  ProviderHttpError,
} from "@/lib/providers/types";
import {
  AiPricingCacheUnavailableError,
  AiPricingCacheWarmingError,
} from "@/lib/services/ai-pricing/cache";
import {
  admitAppInferenceCacheOnly,
  InferenceAppAffiliateUnsupportedError,
} from "@/lib/services/app-inference-admission";
import { appsService } from "@/lib/services/apps";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import { InferenceBalanceCacheWarmingError } from "@/lib/services/inference-billing-fast-path";
import { isKnownUnacceptedProviderError } from "@/lib/services/inference-provider-outcome";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import { settleOffResponsePath } from "@/lib/utils/settle-off-response-path";
import type { AppEnv } from "@/types/cloud-worker-env";
import { reservationOutputTokens } from "./chat-reservation";

const ROUTE_MAX_DURATION = 800;
const COST_SAFETY_MULTIPLIER = 1.5;

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

function isProviderHttpError(error: unknown): error is ProviderHttpError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number" &&
      "error" in error,
  );
}

function providerFailureResponse(error: unknown): {
  status: number;
  body: {
    error: { message: string; type: string; code: string };
  };
} {
  if (isProviderHttpError(error)) {
    const status = error.status;
    return {
      status,
      body: {
        error: {
          message: error.error.message,
          type:
            error.error.type ??
            (status === 402
              ? "insufficient_quota"
              : status === 429
                ? "rate_limit_error"
                : "api_error"),
          code:
            error.error.code ??
            (status === 402
              ? "provider_insufficient_credits"
              : status === 429
                ? "provider_rate_limited"
                : "provider_error"),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("insufficient funds") ||
    normalized.includes("insufficient credits") ||
    (normalized.includes("credits") && normalized.includes("top up"))
  ) {
    return {
      status: 402,
      body: {
        error: {
          message,
          type: "insufficient_quota",
          code: "provider_insufficient_credits",
        },
      },
    };
  }

  return {
    status: 503,
    body: {
      error: {
        message: "Service temporarily unavailable.",
        type: "api_error",
        code: "provider_error",
      },
    },
  };
}

function openAiError(
  message: string,
  code: string,
  status: number,
  type = "api_error",
  headers?: HeadersInit,
): Response {
  return Response.json({ error: { message, type, code } }, { status, headers });
}

function usageFromUnknown(value: unknown): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completionTokens = (usage as { completion_tokens?: unknown })
    .completion_tokens;
  if (
    !Number.isSafeInteger(promptTokens) ||
    (promptTokens as number) < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    (completionTokens as number) < 0
  ) {
    return null;
  }
  return {
    inputTokens: promptTokens as number,
    outputTokens: completionTokens as number,
  };
}

function outputContentFromUnknown(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function streamPartFromUnknown(value: unknown): {
  content: string;
  usage: ProviderUsage | null;
} {
  if (!value || typeof value !== "object") {
    return { content: "", usage: null };
  }
  const choices = (value as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : null;
  const delta =
    first && typeof first === "object"
      ? (first as { delta?: unknown }).delta
      : null;
  const content =
    delta && typeof delta === "object"
      ? (delta as { content?: unknown }).content
      : undefined;
  return {
    content: typeof content === "string" ? content : "",
    usage: usageFromUnknown(value),
  };
}

function inputText(messages: OpenAIChatMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join(" ");
}

async function __next_OPTIONS(request: Request): Promise<Response> {
  return createPreflightResponse(request.headers.get("origin"), [
    "POST",
    "OPTIONS",
  ]);
}

export async function handlePOST(
  request: Request,
  context: RouteContext<{ id: string }>,
  executionCtx?: WorkerExecutionContext,
): Promise<Response> {
  const origin = request.headers.get("origin");
  const withCors = (response: Response): Response =>
    addCorsHeaders(response, origin, ["POST", "OPTIONS"]);
  const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);

  if (!executionCtx) {
    return withCors(
      openAiError(
        "Authorization cache is warming. Retry shortly.",
        "auth_cache_warming",
        503,
        "api_error",
        { "Retry-After": "1" },
      ),
    );
  }
  if (!context?.params) {
    return withCors(
      openAiError(
        "Missing route parameters",
        "missing_route_parameters",
        400,
        "invalid_request_error",
      ),
    );
  }
  const { id: appId } = await context.params;

  let chatRequest: OpenAIChatRequest;
  try {
    chatRequest = (await request.json()) as OpenAIChatRequest;
  } catch {
    // error-policy:J3 malformed JSON is an explicit invalid request.
    return withCors(
      openAiError(
        "Invalid JSON body",
        "invalid_json",
        400,
        "invalid_request_error",
      ),
    );
  }
  if (
    !chatRequest ||
    typeof chatRequest !== "object" ||
    typeof chatRequest.model !== "string" ||
    !Array.isArray(chatRequest.messages) ||
    chatRequest.messages.length === 0
  ) {
    return withCors(
      openAiError(
        "model and a non-empty messages array are required",
        "missing_required_parameter",
        400,
        "invalid_request_error",
      ),
    );
  }

  const auth = await resolveInferenceAuthContext(request, {
    executionCtx,
    cacheOnly: true,
  });
  if (auth.kind !== "authorized") {
    if (auth.kind === "warming") {
      return withCors(
        openAiError(
          "Authorization cache is warming. Retry shortly.",
          "auth_cache_warming",
          503,
          "api_error",
          { "Retry-After": "1" },
        ),
      );
    }
    const forbidden =
      auth.kind === "suspended" ||
      (auth.kind === "rejected" && auth.status === 403);
    return withCors(
      openAiError(
        forbidden ? "Account access is disabled" : "Authentication required",
        forbidden ? "access_disabled" : "unauthorized",
        forbidden ? 403 : 401,
        forbidden ? "permission_error" : "authentication_error",
      ),
    );
  }

  const appPromise = appsService.getByIdCacheOnly(appId, { executionCtx });
  const scopePromise = auth.ctx.apiKeyId
    ? appsService.getApiKeyOwningAppIdCacheOnly(auth.ctx.apiKeyId, {
        executionCtx,
      })
    : Promise.resolve({ kind: "ready" as const, owningAppId: null });
  let rateLimitPromise: Promise<Response | null>;
  try {
    rateLimitPromise = enforceOrgRateLimit(auth.ctx.orgId, "completions", {
      cacheOnly: true,
      executionCtx,
    });
    const [appResolution, scopeResolution, rateLimited] = await Promise.all([
      appPromise,
      scopePromise,
      rateLimitPromise,
    ]);

    if (rateLimited) {
      return withCors(
        openAiError(
          rateLimited.status === 429
            ? "Organization rate limit exceeded"
            : "Rate-limit authorization is unavailable. Retry shortly.",
          rateLimited.status === 429
            ? "rate_limit_exceeded"
            : "rate_limit_unavailable",
          rateLimited.status === 429 ? 429 : 503,
          rateLimited.status === 429 ? "rate_limit_error" : "api_error",
          {
            "Retry-After":
              rateLimited.headers.get("Retry-After") ??
              (rateLimited.status === 429 ? "60" : "1"),
          },
        ),
      );
    }
    if (appResolution.kind !== "ready") {
      return withCors(
        openAiError(
          "Application authorization cache is warming. Retry shortly.",
          "app_cache_warming",
          503,
          "api_error",
          { "Retry-After": "1" },
        ),
      );
    }
    if (scopeResolution.kind !== "ready") {
      return withCors(
        openAiError(
          "API-key scope cache is warming. Retry shortly.",
          "app_scope_cache_warming",
          503,
          "api_error",
          { "Retry-After": "1" },
        ),
      );
    }
    if (!appResolution.app) {
      return withCors(
        openAiError(
          "App not found",
          "app_not_found",
          404,
          "invalid_request_error",
        ),
      );
    }

    const app = appResolution.app;
    if (
      isCrossAppKeyUsage({
        apiKeyId: auth.ctx.apiKeyId,
        owningAppId: scopeResolution.owningAppId,
        requestedAppId: appId,
      }) ||
      (!app.monetization_enabled && app.organization_id !== auth.ctx.orgId)
    ) {
      return withCors(
        openAiError(
          "Access denied to this app",
          "access_denied",
          403,
          "invalid_request_error",
        ),
      );
    }

    const model = canonicalizeCerebrasModelId(chatRequest.model);
    chatRequest.model = model;
    if (!hasLanguageModelProviderConfigured(model)) {
      return withCors(
        openAiError(
          getAiProviderConfigurationError(),
          "ai_provider_not_configured",
          503,
          "service_unavailable",
        ),
      );
    }

    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);
    const billingSource = resolveAiProviderSource(model) ?? "gateway";
    const estimatedInputTokens = estimateTokens(
      inputText(chatRequest.messages),
    );
    const estimatedOutputTokens = reservationOutputTokens(
      chatRequest.max_tokens,
    );
    let estimatedBaseCost: number;
    try {
      ({ totalCost: estimatedBaseCost } = await calculateCost(
        normalizedModel,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
        billingSource,
        { cacheOnly: true, executionCtx },
      ));
    } catch (error) {
      if (
        error instanceof AiPricingCacheWarmingError ||
        error instanceof AiPricingCacheUnavailableError
      ) {
        return withCors(
          openAiError(
            "Pricing authorization cache is warming. Retry shortly.",
            "pricing_cache_warming",
            503,
            "api_error",
            { "Retry-After": "1" },
          ),
        );
      }
      throw error;
    }

    const reservedBaseCost = estimatedBaseCost * COST_SAFETY_MULTIPLIER;
    const requestId = crypto.randomUUID();
    let admission: Awaited<ReturnType<typeof admitAppInferenceCacheOnly>>;
    try {
      admission = await admitAppInferenceCacheOnly({
        app,
        appId,
        userId: auth.ctx.userId,
        organizationId: auth.ctx.orgId,
        estimatedBaseCostUsd: reservedBaseCost,
        description: `App chat: ${model}`,
        idempotencyKey: requestId,
        metadata: {
          type: "app_chat",
          model,
          provider,
          billingSource,
          estimatedInputTokens,
          estimatedOutputTokens,
          safetyMultiplier: COST_SAFETY_MULTIPLIER,
          streaming: Boolean(chatRequest.stream),
        },
        requestId,
        model,
        provider,
        billingSource,
        affiliateCode: request.headers.get("X-Affiliate-Code"),
        authorization: auth.ctx.authorization,
        executionCtx,
      });
    } catch (error) {
      if (error instanceof InferenceAppAffiliateUnsupportedError) {
        return withCors(
          openAiError(
            "App monetization and affiliate attribution cannot be combined.",
            "unsupported_billing_combination",
            400,
            "invalid_request_error",
          ),
        );
      }
      if (error instanceof InsufficientCreditsError) {
        return withCors(
          Response.json(
            {
              error: {
                message: `Insufficient cloud credits. Required: $${error.required.toFixed(4)}`,
                type: "insufficient_quota",
                code: "insufficient_credits",
                required: error.required,
                balance: error.available,
              },
            },
            { status: 402 },
          ),
        );
      }
      if (
        error instanceof InferenceBalanceCacheWarmingError ||
        error instanceof AiPricingCacheWarmingError ||
        error instanceof AiPricingCacheUnavailableError
      ) {
        return withCors(
          openAiError(
            "Billing authorization cache is warming. Retry shortly.",
            "billing_cache_warming",
            503,
            "api_error",
            { "Retry-After": "1" },
          ),
        );
      }
      throw error;
    }

    const settle = (
      kind: "zero" | "unknown" | "actual",
      actualBaseCost?: number,
    ): void => {
      void settleOffResponsePath(executionCtx, async () => {
        try {
          const reconciliation =
            kind === "zero"
              ? await admission.settle(0)
              : kind === "actual" && actualBaseCost !== undefined
                ? await admission.settle(actualBaseCost)
                : await admission.settleUnknown();
          if (reconciliation?.adjustmentType === "uncollected_overage") {
            logger.error("[App Chat] Final usage overage was not collected", {
              appId,
              requestId,
              organizationId: auth.ctx.orgId,
              reserved: reconciliation.reservedAmount,
              actual: reconciliation.actualCost,
            });
          }
        } catch (error) {
          // error-policy:J7 the DO alarm retains the pinned recovery record;
          // this task failure must remain visible without delaying the response.
          logger.error("[App Chat] Deferred settlement failed", {
            appId,
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    };

    let providerResponse: Response;
    let providerDispatchStarted = false;
    try {
      const { primary, fallback } = getProviderForModelWithFallback(model);
      await admission.markProviderDispatched();
      providerDispatchStarted = true;
      providerResponse = await withProviderFallback(
        () =>
          primary.chatCompletions(chatRequest, {
            signal: request.signal,
            timeoutMs: routeTimeoutMs,
          }),
        fallback
          ? () =>
              fallback.chatCompletions(chatRequest, {
                signal: request.signal,
                timeoutMs: routeTimeoutMs,
              })
          : null,
      );
    } catch (error) {
      if (!providerDispatchStarted || isKnownUnacceptedProviderError(error)) {
        settle("zero");
      } else {
        settle("unknown");
      }
      const failure = providerFailureResponse(error);
      return withCors(Response.json(failure.body, { status: failure.status }));
    }

    if (!providerResponse.ok) {
      settle("zero");
      return withCors(providerResponse);
    }

    if (chatRequest.stream) {
      const reader = providerResponse.body?.getReader();
      if (!reader) {
        settle("unknown");
        const payload = `data: ${JSON.stringify({
          error: {
            message: "No response from provider.",
            type: "api_error",
            code: "empty_response",
          },
        })}\n\ndata: [DONE]\n\n`;
        return withCors(
          new Response(payload, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          }),
        );
      }

      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >();
      const writer = writable.getWriter();
      const decoder = new TextDecoder();
      let lineBuffer = "";
      let outputContent = "";
      let observedUsage: ProviderUsage | null = null;
      const processStream = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const part = streamPartFromUnknown(JSON.parse(data));
                outputContent += part.content;
                observedUsage = part.usage ?? observedUsage;
              } catch {
                // error-policy:J3 non-JSON provider events are forwarded but
                // cannot be treated as trusted billing usage.
              }
            }
          }
          lineBuffer += decoder.decode();
          if (lineBuffer.startsWith("data: ")) {
            const data = lineBuffer.slice(6).trim();
            if (data && data !== "[DONE]") {
              try {
                const part = streamPartFromUnknown(JSON.parse(data));
                outputContent += part.content;
                observedUsage = part.usage ?? observedUsage;
              } catch {
                // error-policy:J3 the final untrusted event remains unmetered.
              }
            }
          }
          await writer.close();

          const usage = observedUsage ?? {
            inputTokens: estimatedInputTokens,
            outputTokens: estimateTokens(outputContent),
          };
          try {
            const { totalCost: actualBaseCost } = await calculateCost(
              normalizedModel,
              provider,
              usage.inputTokens,
              usage.outputTokens,
              billingSource,
              { cacheOnly: true, executionCtx },
            );
            await admission.settle(actualBaseCost);
          } catch (error) {
            await admission.settleUnknown();
            // error-policy:J7 provider output was delivered, so conservative
            // settlement is retained and the pricing failure is observable.
            logger.error("[App Chat] Streaming exact settlement failed", {
              appId,
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } catch (error) {
          try {
            await writer.abort(error);
          } catch (abortError) {
            // error-policy:J6 the original stream failure owns the response;
            // writer teardown is best effort after the client disconnects.
            logger.debug("[App Chat] Stream writer abort failed", {
              appId,
              error:
                abortError instanceof Error
                  ? abortError.message
                  : String(abortError),
            });
          }
          try {
            await admission.settleUnknown();
          } catch (settlementError) {
            // error-policy:J7 the alarm remains the durable recovery path.
            logger.error("[App Chat] Interrupted stream settlement failed", {
              appId,
              requestId,
              error:
                settlementError instanceof Error
                  ? settlementError.message
                  : String(settlementError),
            });
          }
        }
      })();
      executionCtx.waitUntil(processStream);

      return withCors(
        new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
      );
    }

    let responseData: unknown;
    try {
      responseData = await providerResponse.json();
    } catch (error) {
      settle("unknown");
      logger.error("[App Chat] Provider returned malformed JSON", {
        appId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return withCors(
        openAiError(
          "Provider returned an invalid response.",
          "invalid_provider_response",
          502,
        ),
      );
    }

    const usage = usageFromUnknown(responseData) ?? {
      inputTokens: estimatedInputTokens,
      outputTokens: estimateTokens(outputContentFromUnknown(responseData)),
    };
    try {
      const { totalCost: actualBaseCost } = await calculateCost(
        normalizedModel,
        provider,
        usage.inputTokens,
        usage.outputTokens,
        billingSource,
        { cacheOnly: true, executionCtx },
      );
      settle("actual", actualBaseCost);
    } catch (error) {
      settle("unknown");
      logger.error("[App Chat] Exact settlement pricing failed", {
        appId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return withCors(Response.json(responseData));
  } catch (error) {
    if (error instanceof OrgRateLimitCacheNotReadyError) {
      return withCors(
        openAiError(
          "Rate-limit authorization cache is warming. Retry shortly.",
          "rate_limit_cache_warming",
          503,
          "api_error",
          { "Retry-After": "1" },
        ),
      );
    }
    throw error;
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();

honoRouter.options("/", async (c) => {
  try {
    return await __next_OPTIONS(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});

honoRouter.post("/", async (c) => {
  let executionCtx: WorkerExecutionContext | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // error-policy:J4 non-Worker hosts receive the explicit retryable response
    // from handlePOST; they cannot safely detach durable accounting.
    executionCtx = undefined;
  }
  try {
    return await handlePOST(
      c.req.raw,
      nextStyleParams(c, ROUTE_PARAM_SPEC),
      executionCtx,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default honoRouter;
