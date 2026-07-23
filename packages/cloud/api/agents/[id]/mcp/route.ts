/**
 * /api/agents/:id/mcp — Per-agent MCP (Model Context Protocol) endpoint.
 *
 * GET → MCP server metadata + tool catalog.
 * POST → JSON-RPC dispatch (`initialize`, `tools/list`, `tools/call`, `ping`).
 *
 * The `chat` tool reserves credits, resolves the configured model provider,
 * then reconciles actual usage. Returns plain JSON, not SSE.
 */

import { calculateCreditMarkup } from "@elizaos/cloud-shared/billing";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
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

const DEFAULT_MIN_OUTPUT_TOKENS = 4096;

const MCPRequestSchema = z.object({
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

const ToolCallParamsSchema = z.object({
  name: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const ChatArgumentsSchema = z.object({
  message: z.string().trim().min(1),
  model: z.string().trim().min(1).default("gpt-5-mini"),
});

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
  if (!character.is_public || !character.mcp_enabled) {
    return c.json({ error: "MCP not accessible for this agent" }, 403);
  }

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const bioText = Array.isArray(character.bio)
    ? character.bio.join("\n")
    : character.bio;
  const markupPct = Number(character.inference_markup_percentage || 0);

  return c.json({
    name: character.name,
    description: bioText,
    version: "1.0.0",
    protocol: "2024-11-05",
    capabilities: { tools: {}, resources: {}, prompts: {} },
    pricing: character.monetization_enabled
      ? {
          type: "credits",
          markupPercentage: markupPct,
          description: `Base inference cost + ${markupPct}% creator markup`,
        }
      : { type: "credits", description: "Standard inference costs" },
    endpoints: {
      mcp: `${baseUrl}/api/agents/${id}/mcp`,
      a2a: `${baseUrl}/api/agents/${id}/a2a`,
    },
    tools: [
      {
        name: "chat",
        description: `Send a message to ${character.name} and get a response`,
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "The message to send" },
            model: {
              type: "string",
              description: "Model to use (default: gpt-5-mini)",
              enum: ["gpt-5-mini", "gemma-4-31b", "claude-sonnet-5"],
            },
          },
          required: ["message"],
        },
      },
      {
        name: "get_info",
        description: `Get information about ${character.name}`,
        inputSchema: { type: "object", properties: {} },
      },
    ],
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
  const validation = MCPRequestSchema.safeParse(body);
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
  if (!character.is_public || !character.mcp_enabled) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "MCP not accessible" },
        id: rpcId,
      },
      403,
    );
  }

  switch (method) {
    case "initialize":
      return c.json({
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: character.name, version: "1.0.0" },
          capabilities: { tools: {} },
        },
        id: rpcId,
      });

    case "tools/list":
      return c.json({
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              name: "chat",
              description: `Send a message to ${character.name}`,
              inputSchema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  model: { type: "string" },
                },
                required: ["message"],
              },
            },
            {
              name: "get_info",
              description: `Get information about ${character.name}`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
        id: rpcId,
      });

    case "tools/call":
      return handleToolCall(c, character, params ?? {}, rpcId, {
        id: auth.ctx.userId,
        organization_id: auth.ctx.orgId,
        apiKeyId: auth.ctx.apiKeyId,
        authorization: auth.ctx.authorization,
        executionCtx,
      });

    case "ping":
      return c.json({ jsonrpc: "2.0", result: {}, id: rpcId });

    default:
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32601, message: "Method not found" },
          id: rpcId,
        },
        400,
      );
  }
});

export async function handleToolCall(
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
  const parsedParams = ToolCallParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32602, message: "valid tool call params are required" },
        id: rpcId,
      },
      400,
    );
  }
  const { name, arguments: args } = parsedParams.data;

  if (name === "get_info") {
    const bioText = Array.isArray(character.bio)
      ? character.bio.join("\n")
      : character.bio;
    return c.json({
      jsonrpc: "2.0",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: character.name,
              bio: bioText,
              monetization: character.monetization_enabled,
              markup: character.inference_markup_percentage,
            }),
          },
        ],
      },
      id: rpcId,
    });
  }

  if (name === "chat") {
    const parsedArguments = ChatArgumentsSchema.safeParse(args);
    if (!parsedArguments.success) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32602, message: "valid chat arguments are required" },
          id: rpcId,
        },
        400,
      );
    }
    const { message, model } = parsedArguments.data;

    const bioText = Array.isArray(character.bio)
      ? character.bio.join("\n")
      : character.bio;
    const systemPrompt =
      character.system || `You are ${character.name}. ${bioText}`;
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: message },
    ];

    const provider = getProviderFromModel(model);
    const billingSource = resolveAiProviderSource(model) ?? "gateway";
    const markupPct =
      character.monetization_enabled &&
      character.inference_markup_percentage != null
        ? parseAgentMonetizationNumber(
            character.inference_markup_percentage,
            "inference_markup_percentage",
          )
        : 0;
    const envForThinking = getAnthropicCotEnv(c.env);
    const agentThinkingBudget = parseThinkingBudgetFromCharacterSettings(
      character.settings,
    );
    const effectiveThinkingBudget = resolveAnthropicThinkingBudgetTokens(
      model,
      envForThinking,
      agentThinkingBudget,
    );
    const baseOutputTokens = DEFAULT_MIN_OUTPUT_TOKENS;
    const providerOutputTokens =
      effectiveThinkingBudget != null
        ? baseOutputTokens + effectiveThinkingBudget
        : baseOutputTokens;
    const creatorPolicy = createAgentInferenceRecoveryPolicy({
      agentId: character.id,
      agentName: character.name,
      ownerId: character.user_id,
      markupPercent: markupPct,
      protocol: "mcp",
    });
    const chargeMultiplier = agentInferenceChargeMultiplier(creatorPolicy);
    const estimatedInputTokens = Math.max(
      1,
      Math.ceil(
        estimateTokens(messages.map((entry) => entry.content).join(" ")) *
          chargeMultiplier,
      ),
    );
    const estimatedOutputTokens = Math.ceil(
      providerOutputTokens * chargeMultiplier,
    );
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
          description: `Agent MCP: ${character.name} (${model})`,
          metadata: {
            [AGENT_INFERENCE_RECOVERY_METADATA_KEY]: creatorPolicy,
            protocol: "mcp",
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
            logger.error("[Agent MCP] Final usage overage was not collected", {
              agentId: character.id,
              ownerId: character.user_id,
              consumerOrgId: authUser.organization_id,
              reserved: reconciliation.reservedAmount,
              actual: reconciliation.actualCost,
            });
          }
        } catch (error) {
          // error-policy:J7 the DO alarm replays this pinned charge while the
          // post-provider accounting failure remains visible to operators.
          logger.error("[Agent MCP] Deferred settlement failed", {
            agentId: character.id,
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    };

    let providerDispatchStarted = false;
    try {
      logger.info("[Agent MCP] Invoking configured provider", {
        agentId: character.id,
        model,
        maxOutputTokens: providerOutputTokens,
        thinkingBudgetTokens: effectiveThinkingBudget,
      });
      const languageModel = getLanguageModel(model);
      await admission.markProviderDispatched();
      providerDispatchStarted = true;
      const result = await streamText({
        model: languageModel,
        messages,
        maxOutputTokens: providerOutputTokens,
        ...mergeAnthropicCotProviderOptions(
          model,
          envForThinking,
          // Feed the already-resolved effective budget, not the raw character
          // setting. Idempotent: a positive budget re-resolves to itself and
          // `0` re-resolves to off, so the provider's thinking policy is exactly
          // what was priced — never a recomputed, divergent value (#16148).
          effectiveThinkingBudget ?? 0,
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
          content: [{ type: "text", text: fullText }],
          _meta: {
            admittedOutputTokens: providerOutputTokens,
            cost: {
              base: actualBaseCost,
              markup: actualCreatorMarkup,
              total: actualTotal,
            },
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
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
      logger.error("[Agent MCP] Error generating response", {
        error: error instanceof Error ? error.message : "Unknown error",
        agentId: character.id,
      });
      return c.json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Internal error",
        },
        id: rpcId,
      });
    }
  }

  return c.json({
    jsonrpc: "2.0",
    error: { code: -32601, message: `Unknown tool: ${name}` },
    id: rpcId,
  });
}

app.options("/", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  }),
);

export default app;
