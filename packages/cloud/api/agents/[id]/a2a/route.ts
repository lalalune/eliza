/**
 * /api/agents/:id/a2a — Per-agent A2A endpoint.
 *
 * GET → returns the A2A Agent Card (cached 1h).
 * POST → JSON-RPC dispatch (`chat`, `getAgentInfo`). Bills the caller's org;
 * if `monetization_enabled`, credits the creator's redeemable earnings.
 *
 * Per the realtime audit: A2A is JSON-RPC sync, not streaming — chat collects
 * the full text before responding rather than streaming back.
 */

import { calculateCreditMarkup } from "@elizaos/cloud-shared/billing";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { UserCharacter } from "@/db/repositories/characters";
import { safeUnknownErrorMessage } from "@/lib/api/cloud-worker-errors";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from "@/lib/cors-constants";
import {
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError,
} from "@/lib/middleware/rate-limit";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
} from "@/lib/pricing";
import {
  type AnthropicCotEnv,
  mergeAnthropicCotProviderOptions,
  parseThinkingBudgetFromCharacterSettings,
  resolveAnthropicThinkingBudgetTokens,
} from "@/lib/providers/anthropic-thinking";
import {
  getLanguageModel,
  isProviderConfigurationError,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import {
  AGENT_INFERENCE_RECOVERY_METADATA_KEY,
  agentInferenceChargeMultiplier,
  createAgentInferenceRecoveryPolicy,
  parseAgentMonetizationNumber,
  recordAgentInferenceCreatorEarnings,
} from "@/lib/services/agent-monetization";
import { charactersService } from "@/lib/services/characters/characters";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import { InferenceBalanceCacheWarmingError } from "@/lib/services/inference-billing-fast-path";
import { isKnownUnacceptedProviderError } from "@/lib/services/inference-provider-outcome";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import { logger } from "@/lib/utils/logger";
import { settleOffResponsePath } from "@/lib/utils/settle-off-response-path";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const A2A_TEXT_OUTPUT_TOKENS = 500;

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  id: z.union([z.string(), z.number()]),
});

const ProviderUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const A2AChatParamsSchema = z.object({
  model: z.string().trim().min(1).default("gpt-5-mini"),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
});

export function generateAgentCard(character: UserCharacter, baseUrl: string) {
  const bioText = Array.isArray(character.bio)
    ? character.bio.join("\n")
    : character.bio;
  const markupPct = Number(character.inference_markup_percentage || 0);
  const hasMonetization = character.monetization_enabled && markupPct > 0;

  return {
    name: character.name,
    description: bioText,
    image: character.avatar_url || `${baseUrl}/default-avatar.png`,
    version: "1.0.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: [
        {
          scheme: "bearer",
          description: "API Key authentication via Authorization header",
        },
      ],
    },
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: `Chat with ${character.name}`,
        pricing: {
          type: "token-based" as const,
          inputCostPer1k: 0.005,
          outputCostPer1k: 0.015,
          ...(hasMonetization && { markupPercentage: markupPct }),
        },
      },
      {
        id: "generate_image",
        name: "Image Generation",
        description: `Generate images as ${character.name}`,
        pricing: {
          type: "fixed" as const,
          amount: 0.05,
          ...(hasMonetization && { markupPercentage: markupPct }),
        },
      },
    ],
    pricing: {
      currency: "USD",
      paymentMethods: ["api_key_credits"],
      minimumPayment: 0.001,
    },
    // SECURITY: this card is served UNAUTHENTICATED (public /api/agents prefix)
    // with CORS *. Do NOT expose the creator's internal user_id/organization_id
    // here (deanonymization/correlation of which org owns which agents). The MCP
    // card omits these too — keep parity.
  };
}

const app = new Hono<AppEnv>();

function getAnthropicCotEnv(env: AppEnv["Bindings"]): AnthropicCotEnv {
  return {
    ANTHROPIC_COT_BUDGET:
      typeof env.ANTHROPIC_COT_BUDGET === "string"
        ? env.ANTHROPIC_COT_BUDGET
        : undefined,
    ANTHROPIC_COT_BUDGET_MAX:
      typeof env.ANTHROPIC_COT_BUDGET_MAX === "string"
        ? env.ANTHROPIC_COT_BUDGET_MAX
        : undefined,
  };
}

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const character = await charactersService.getById(id);
  if (!character) return c.json({ error: "Agent not found" }, 404);
  if (!character.is_public)
    return c.json({ error: "Agent is not public" }, 403);
  if (!character.a2a_enabled) {
    return c.json({ error: "A2A not enabled for this agent" }, 403);
  }

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const agentCard = generateAgentCard(character, baseUrl);

  return c.json(agentCard, 200, {
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
});

app.post("/", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // error-policy:J3 malformed JSON is an explicit JSON-RPC parse failure.
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      },
      400,
    );
  }
  const validation = JsonRpcRequestSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      },
      400,
    );
  }

  const { method, params, id: rpcId } = validation.data;
  let executionCtx: { waitUntil(promise: Promise<unknown>): void };
  try {
    executionCtx = c.executionCtx;
  } catch {
    // error-policy:J4 provider-bearing public routes require a Worker lifetime
    // so cache hydration and accounting cannot be detached and lost.
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32005,
          message: "Authorization cache is warming. Retry shortly.",
        },
        id: rpcId,
      },
      503,
    );
  }

  const auth = await resolveInferenceAuthContext(c.req.raw, {
    executionCtx,
    cacheOnly: true,
    traceId: c.get("traceId"),
  });
  if (auth.kind !== "authorized") {
    const status =
      auth.kind === "suspended" ||
      (auth.kind === "rejected" && auth.status === 403)
        ? 403
        : auth.kind === "warming"
          ? 503
          : 401;
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: status === 503 ? -32005 : -32002,
          message:
            status === 503
              ? "Authorization cache is warming. Retry shortly."
              : status === 403
                ? "Account access is disabled"
                : "Authentication required",
        },
        id: rpcId,
      },
      status,
    );
  }

  let rateLimited: Response | null;
  try {
    rateLimited = await enforceOrgRateLimit(auth.ctx.orgId, "standard", {
      cacheOnly: true,
      executionCtx,
    });
  } catch (error) {
    if (error instanceof OrgRateLimitCacheNotReadyError) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32005,
            message:
              "Rate-limit authorization cache is warming. Retry shortly.",
          },
          id: rpcId,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    throw error;
  }
  if (rateLimited) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: rateLimited.status === 429 ? -32004 : -32005,
          message:
            rateLimited.status === 429
              ? "Organization rate limit exceeded"
              : "Rate-limit authorization is unavailable. Retry shortly.",
        },
        id: rpcId,
      },
      rateLimited.status === 429 ? 429 : 503,
      rateLimited.status === 429
        ? { "Retry-After": rateLimited.headers.get("Retry-After") ?? "60" }
        : { "Retry-After": "1" },
    );
  }

  const characterResolution = await charactersService.getByIdCacheOnly(id, {
    executionCtx,
  });
  if (characterResolution.kind !== "ready") {
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32005,
          message: "Agent authorization cache is warming. Retry shortly.",
        },
        id: rpcId,
      },
      503,
      { "Retry-After": "1" },
    );
  }
  const character = characterResolution.character;
  if (!character.is_public || !character.a2a_enabled) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Agent not accessible" },
        id: rpcId,
      },
      403,
    );
  }

  if (method === "chat") {
    return handleChat(c, character, params ?? {}, rpcId, {
      id: auth.ctx.userId,
      organization_id: auth.ctx.orgId,
      apiKeyId: auth.ctx.apiKeyId,
      authorization: auth.ctx.authorization,
      executionCtx,
    });
  }

  if (method === "getAgentInfo") {
    return c.json({
      jsonrpc: "2.0",
      result: {
        name: character.name,
        bio: character.bio,
        category: character.category,
        tags: character.tags,
        monetizationEnabled: character.monetization_enabled,
        markupPercentage: character.inference_markup_percentage,
      },
      id: rpcId,
    });
  }

  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: rpcId,
    },
    400,
  );
});

async function handleChat(
  c: AppContext,
  character: {
    id: string;
    name: string;
    user_id: string;
    organization_id: string;
    monetization_enabled: boolean;
    inference_markup_percentage: string | null;
    system: string | null;
    bio: string | string[];
    settings: Record<string, unknown>;
  },
  params: Record<string, unknown>,
  rpcId: string | number,
  authUser: {
    id: string;
    organization_id: string;
    apiKeyId: string | null;
    authorization: NonNullable<
      Extract<
        Awaited<ReturnType<typeof resolveInferenceAuthContext>>,
        { kind: "authorized" }
      >["ctx"]["authorization"]
    >;
    executionCtx: { waitUntil(promise: Promise<unknown>): void };
  },
): Promise<Response> {
  const parsedParams = A2AChatParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32602, message: "valid messages are required" },
        id: rpcId,
      },
      400,
    );
  }
  const { model, messages } = parsedParams.data;

  const bioText = Array.isArray(character.bio)
    ? character.bio.join("\n")
    : character.bio;
  const systemPrompt =
    character.system || `You are ${character.name}. ${bioText}`;

  const fullMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages,
  ];

  const provider = getProviderFromModel(model);
  const billingSource = resolveAiProviderSource(model) ?? "gateway";
  const agentThinkingBudget = parseThinkingBudgetFromCharacterSettings(
    character.settings,
  );
  const envForThinking = getAnthropicCotEnv(c.env);
  const effectiveThinkingBudget = resolveAnthropicThinkingBudgetTokens(
    model,
    envForThinking,
    agentThinkingBudget,
  );
  const maxOutputTokens =
    A2A_TEXT_OUTPUT_TOKENS + (effectiveThinkingBudget ?? 0);
  const markupPct =
    character.monetization_enabled &&
    character.inference_markup_percentage != null
      ? parseAgentMonetizationNumber(
          character.inference_markup_percentage,
          "inference_markup_percentage",
        )
      : 0;
  const creatorPolicy = createAgentInferenceRecoveryPolicy({
    agentId: character.id,
    agentName: character.name,
    ownerId: character.user_id,
    markupPercent: markupPct,
    protocol: "a2a",
  });
  const chargeMultiplier = agentInferenceChargeMultiplier(creatorPolicy);
  const estimatedInputTokens = Math.max(
    1,
    Math.ceil(
      estimateTokens(fullMessages.map((message) => message.content).join(" ")) *
        chargeMultiplier,
    ),
  );
  const estimatedOutputTokens = Math.ceil(maxOutputTokens * chargeMultiplier);
  const requestId = crypto.randomUUID();
  let providerUsage: z.infer<typeof ProviderUsageSchema> | null = null;
  let admission: Awaited<ReturnType<typeof admitOrganizationInference>>;
  try {
    admission = await admitOrganizationInference({
      context: {
        organizationId: authUser.organization_id,
        userId: authUser.id,
        apiKeyId: authUser.apiKeyId,
        model,
        provider,
        billingSource,
        requestId,
        description: `Agent A2A: ${character.name} (${model})`,
        metadata: {
          [AGENT_INFERENCE_RECOVERY_METADATA_KEY]: creatorPolicy,
          protocol: "a2a",
          agentId: character.id,
        },
      },
      apiKeyId: authUser.apiKeyId,
      estimatedInputTokens,
      estimatedOutputTokens,
      authorization: authUser.authorization,
      executionCtx: authUser.executionCtx,
      afterDebitBeforeLeaseRelease: async (actualTotal, reconciliation) => {
        if (
          actualTotal <= 0 ||
          reconciliation?.adjustmentType === "uncollected_overage"
        ) {
          return;
        }
        await recordAgentInferenceCreatorEarnings({
          policy: creatorPolicy,
          requestId,
          totalCostUsd: actualTotal,
          consumerOrgId: authUser.organization_id,
          model,
          tokens: providerUsage?.totalTokens,
        });
      },
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return c.json({
        jsonrpc: "2.0",
        error: {
          code: -32003,
          message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
        },
        id: rpcId,
      });
    }
    if (error instanceof InferenceBalanceCacheWarmingError) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32005,
            message: "Billing authorization cache is warming. Retry shortly.",
          },
          id: rpcId,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    throw error;
  }

  const settle = (
    kind: "zero" | "unknown" | "actual",
    actualTotal?: number,
  ): void => {
    void settleOffResponsePath(authUser.executionCtx, async () => {
      try {
        const reconciliation =
          kind === "zero"
            ? await admission.settle(0)
            : kind === "actual" && actualTotal !== undefined
              ? await admission.settle(actualTotal)
              : await admission.settleUnknown();
        if (reconciliation?.adjustmentType === "uncollected_overage") {
          logger.error("[Agent A2A] Final usage overage was not collected", {
            agentId: character.id,
            ownerId: character.user_id,
            consumerOrgId: authUser.organization_id,
            reserved: reconciliation.reservedAmount,
            actual: reconciliation.actualCost,
          });
        }
      } catch (error) {
        // error-policy:J7 provider work is already decided; the DO alarm replays
        // the pinned charge while this failure remains observable.
        logger.error("[Agent A2A] Deferred settlement failed", {
          agentId: character.id,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  let providerDispatchStarted = false;
  try {
    const languageModel = getLanguageModel(model);
    await admission.markProviderDispatched();
    providerDispatchStarted = true;
    const result = await streamText({
      model: languageModel,
      messages: fullMessages,
      maxOutputTokens,
      ...mergeAnthropicCotProviderOptions(
        model,
        envForThinking,
        effectiveThinkingBudget ?? undefined,
      ),
    });

    let fullText = "";
    for await (const delta of result.textStream) {
      fullText += delta;
    }

    const usage = ProviderUsageSchema.parse(await result.usage);
    providerUsage = usage;
    const { totalCost: actualBaseCost } = await calculateCost(
      model,
      provider,
      usage.inputTokens,
      usage.outputTokens,
      billingSource,
      { cacheOnly: true, executionCtx: authUser.executionCtx },
    );
    const { markupCredits: actualCreatorMarkup, totalCredits: actualTotal } =
      calculateCreditMarkup({
        baseCredits: actualBaseCost,
        markupPercent: character.monetization_enabled ? markupPct : 0,
      });

    settle("actual", actualTotal);

    return c.json({
      jsonrpc: "2.0",
      result: {
        content: fullText,
        model,
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
        },
        cost: {
          base: actualBaseCost,
          markup: actualCreatorMarkup,
          total: actualTotal,
        },
      },
      id: rpcId,
    });
  } catch (error) {
    if (
      !providerDispatchStarted ||
      isProviderConfigurationError(error) ||
      isKnownUnacceptedProviderError(error)
    ) {
      settle("zero");
    } else {
      settle("unknown");
    }
    logger.error("[Agent A2A] Error generating response", {
      error: error instanceof Error ? error.message : "Unknown error",
      agentId: character.id,
    });
    return c.json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        // Redact infra/DB/5xx internals from the A2A caller (full error is
        // logged above); deliberate 4xx messages still pass through.
        message: safeUnknownErrorMessage(error),
      },
      id: rpcId,
    });
  }
}

app.options("/", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  }),
);

export default app;
