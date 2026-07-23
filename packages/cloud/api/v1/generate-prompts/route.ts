/**
 * Streams agent-concept suggestions through the shared inference boundary.
 *
 * The Worker authenticates and admits from cache-backed state before provider
 * dispatch; actual-usage settlement continues under `waitUntil`.
 */

import { streamText } from "ai";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "@/lib/pricing";
import {
  getLanguageModel,
  isProviderConfigurationError,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import { InferenceBalanceCacheWarmingError } from "@/lib/services/inference-billing-fast-path";
import { isKnownUnacceptedProviderError } from "@/lib/services/inference-provider-outcome";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import { logger } from "@/lib/utils/logger";
import { settleOffResponsePath } from "@/lib/utils/settle-off-response-path";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const MODEL = "gpt-4o";
const MAX_OUTPUT_TOKENS = 500;

function authFailureResponse(
  c: AppContext,
  resolution: Exclude<
    Awaited<ReturnType<typeof resolveInferenceAuthContext>>,
    { kind: "authorized" }
  >,
): Response {
  if (resolution.kind === "warming") {
    return c.json(
      {
        error: "Authorization cache is warming. Retry shortly.",
        code: "AUTH_CACHE_WARMING",
      },
      503,
    );
  }
  if (resolution.kind === "suspended") {
    return c.json(
      { error: "Account suspended", code: "ACCOUNT_SUSPENDED" },
      403,
    );
  }
  if (resolution.kind === "rejected") {
    return c.json(
      {
        error:
          resolution.status === 403
            ? "Access disabled"
            : "Authentication required",
        code: resolution.status === 403 ? "ACCESS_DISABLED" : "UNAUTHORIZED",
      },
      resolution.status,
    );
  }
  return c.json(
    { error: "Authentication required", code: "UNAUTHORIZED" },
    401,
  );
}

app.post("/", async (c) => {
  let settle:
    | Awaited<ReturnType<typeof admitOrganizationInference>>["settle"]
    | undefined;
  let settleUnknown:
    | Awaited<ReturnType<typeof admitOrganizationInference>>["settleUnknown"]
    | undefined;
  let providerDispatchStarted = false;

  try {
    let body: {
      seed?: string | number;
    };
    try {
      body = (await c.req.json()) as { seed?: string | number };
    } catch {
      // error-policy:J3 malformed request JSON is an explicit invalid request.
      return c.json(
        { error: "Invalid JSON body", code: "INVALID_REQUEST" },
        400,
      );
    }

    const resolution = await resolveInferenceAuthContext(c.req.raw, {
      executionCtx: c.executionCtx,
      cacheOnly: true,
      traceId: c.get("traceId"),
    });
    if (resolution.kind !== "authorized") {
      return authFailureResponse(c, resolution);
    }

    const promptSeed =
      typeof body.seed === "string" || typeof body.seed === "number"
        ? String(body.seed)
        : String(Date.now());
    const systemPrompt = `Generate 4 SHORT, USEFUL agent concepts (max 8 words each) that are DIVERSE and practical for real-world utility.

CRITICAL: Focus on UTILITY-BASED agents that help with real tasks. Mix different domains:
- Business & productivity (sales, support, analytics, scheduling)
- Creative & content (writing, design, research, editing)
- Technical & development (coding, debugging, documentation, DevOps)
- Personal & lifestyle (fitness, finance, learning, wellness)
- Communication & social (community management, translation, moderation)

Keep concepts:
- SHORT (5-8 words maximum)
- PRACTICAL (real utility, not fantasy)
- SPECIFIC (clear use case)
- VARIED (different industries/domains)

Examples of GOOD prompts:
- "Technical documentation writer with dry humor"
- "Personal finance advisor for freelancers"
- "Code reviewer focused on security best practices"
- "Social media content strategist for startups"
- "Customer support specialist with endless patience"
- "Data analyst explaining insights in simple terms"
- "Meeting notes summarizer with action items"
- "Fitness coach for busy professionals"

BAD prompts (too long, too fantasy):
- "Renaissance alchemist trapped in simulation..."
- "Time-traveling wizard from the year..."

Return ONLY a JSON array of exactly 4 strings, nothing else. No markdown, no explanation.

Random seed: ${promptSeed}`;
    const userPrompt =
      "Generate 4 short, practical agent concepts for real-world utility. Keep each under 8 words. Make them diverse across different domains.";
    const provider = getProviderFromModel(MODEL);
    const billingSource = resolveAiProviderSource(MODEL) ?? "openai";
    const requestId = crypto.randomUUID();
    const admission = await admitOrganizationInference({
      context: {
        organizationId: resolution.ctx.orgId,
        userId: resolution.ctx.userId,
        apiKeyId: resolution.ctx.apiKeyId,
        model: MODEL,
        provider,
        billingSource,
        requestId,
      },
      apiKeyId: resolution.ctx.apiKeyId,
      estimatedInputTokens: estimateTokens(`${systemPrompt}\n${userPrompt}`),
      estimatedOutputTokens: MAX_OUTPUT_TOKENS,
      authorization: resolution.ctx.authorization,
      executionCtx: c.executionCtx,
    });
    settle = admission.settle;
    settleUnknown = admission.settleUnknown;
    if (!admission.markProviderDispatched) {
      throw new InferenceBalanceCacheWarmingError();
    }
    await admission.markProviderDispatched();
    providerDispatchStarted = true;
    const result = streamText({
      model: getLanguageModel(MODEL),
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 1.5,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      topP: 0.95,
      abortSignal: c.req.raw.signal,
      onFinish: async ({ usage }) => {
        await settleOffResponsePath(c.executionCtx, async () => {
          if (!usage) {
            await settleUnknown?.();
            return;
          }
          try {
            const { totalCost } = await calculateCost(
              normalizeModelName(MODEL),
              provider,
              usage.inputTokens ?? 0,
              usage.outputTokens ?? 0,
              billingSource,
            );
            await settle?.(totalCost);
          } catch (error) {
            await settleUnknown?.();
            // error-policy:J7 provider work completed, so the conservative
            // settlement is observable even when exact pricing cannot finish.
            logger.error("[Generate Prompts] Exact settlement failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      },
      onAbort: async () => {
        await settleOffResponsePath(c.executionCtx, async () => {
          await settleUnknown?.();
        });
        logger.info("[Generate Prompts] Stream aborted", { model: MODEL });
      },
      onError: async ({ error }: { error: unknown }) => {
        await settleOffResponsePath(c.executionCtx, async () => {
          if (isKnownUnacceptedProviderError(error)) {
            await settle?.(0);
          } else {
            await settleUnknown?.();
          }
        });
        logger.error("[Generate Prompts] Provider stream failed", {
          model: MODEL,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return result.toTextStreamResponse();
  } catch (error) {
    await settleOffResponsePath(c.executionCtx, async () => {
      if (
        !providerDispatchStarted ||
        isProviderConfigurationError(error) ||
        isKnownUnacceptedProviderError(error)
      ) {
        await settle?.(0);
      } else {
        await settleUnknown?.();
      }
    });
    if (error instanceof InferenceBalanceCacheWarmingError) {
      return c.json(
        {
          error: "Billing authorization is warming. Retry shortly.",
          code: "BILLING_CACHE_WARMING",
        },
        503,
      );
    }
    logger.error("[Generate Prompts] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
