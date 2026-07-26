/**
 * Cache-only authorization and durable admission for interactive generation.
 *
 * User-triggered SEO, promotion, and social generation share this boundary so
 * credential, ownership, rate, and balance checks never fall through to
 * Postgres or Railway Redis before an external provider accepts the request.
 * Scheduled jobs use their existing control-plane accounting and must not pass
 * through the interactive entrypoints exported here.
 */

import type { App } from "../../db/repositories/apps";
import { isCrossAppKeyUsage } from "../auth/app-key-scope";
import {
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError,
} from "../middleware/rate-limit";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "../pricing";
import { resolveAiProviderSource } from "../providers/language-model";
import { logger } from "../utils/logger";
import { settleOffResponsePath } from "../utils/settle-off-response-path";
import { appsService } from "./apps";
import {
  type CreditReconciliationResult,
  InsufficientCreditsError,
  MIN_RESERVATION,
} from "./credits";
import {
  acquireInferenceAdmissionLease,
  InferenceAdmissionGateUnavailableError,
  type InferenceAdmissionLease,
  InferenceAdmissionLeaseRejectedError,
  inferenceSettlementAmounts,
  markInferenceAdmissionLeaseDispatched,
  settleInferenceAdmissionLease,
} from "./inference-admission-gate";
import type { InferenceAuthorizationProof } from "./inference-authorization-boundary";
import {
  type ResolvedInferenceAuthContext,
  resolveInferenceAuthContext,
} from "./inference-auth-context";
import {
  debitInferenceCost,
  getGateBalanceHint,
  InferenceBalanceCacheWarmingError,
} from "./inference-billing-fast-path";
import { isKnownUnacceptedProviderError } from "./inference-provider-outcome";
import { admitOrganizationInference } from "./organization-inference-admission";

export interface InteractiveGenerationExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface InteractiveGenerationIdentity {
  readonly organizationId: string;
  readonly userId: string;
  readonly apiKeyId: string | null;
  readonly authorization: InferenceAuthorizationProof;
  readonly executionCtx: InteractiveGenerationExecutionContext;
}

export interface InteractiveAppGenerationContext
  extends InteractiveGenerationIdentity {
  readonly app: App;
}

export type InteractiveAppGenerationResolution =
  | { kind: "ready"; context: InteractiveAppGenerationContext }
  | {
      kind: "warming";
      code: "auth_cache_warming" | "app_cache_warming" | "app_scope_cache_warming" | "rate_cache_warming";
    }
  | {
      kind: "denied";
      status: 401 | 403 | 404;
      code: "unauthorized" | "access_disabled" | "access_denied" | "app_not_found";
    }
  | {
      kind: "rate_limited";
      status: 429 | 503;
      retryAfter: string;
    };

export interface InteractiveTextUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface InteractiveTextGenerationParams {
  readonly identity: InteractiveGenerationIdentity;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
  readonly description: string;
  readonly metadata?: Record<string, unknown>;
}

export interface InteractiveFixedCostGenerationParams {
  readonly identity: InteractiveGenerationIdentity;
  readonly requestId?: string;
  readonly model: string;
  readonly provider: string;
  readonly billingSource: string;
  readonly estimatedCostUsd: number;
  readonly description: string;
  readonly metadata?: Record<string, unknown>;
}

function scheduledSettlement(
  identity: InteractiveGenerationIdentity,
  description: string,
  task: () => Promise<unknown>,
): void {
  void settleOffResponsePath(identity.executionCtx, async () => {
    try {
      await task();
    } catch (error) {
      // error-policy:J7 the Durable Object retains the dispatched lease for
      // alarm recovery; settlement failure is observable without delaying the
      // generated response.
      logger.error("[InteractiveGeneration] Deferred settlement failed", {
        organizationId: identity.organizationId,
        description,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Resolve owner-only app generation state without an authoritative read.
 *
 * The returned authorization proof is immutable and is rechecked by the
 * organization Durable Object in the final dispatch transition.
 */
export async function resolveInteractiveAppGeneration(
  request: Request,
  appId: string,
  executionCtx: InteractiveGenerationExecutionContext,
): Promise<InteractiveAppGenerationResolution> {
  const auth = await resolveInferenceAuthContext(request, {
    cacheOnly: true,
    executionCtx,
  });
  if (auth.kind !== "authorized") {
    if (auth.kind === "warming" || auth.kind === "slow_path") {
      return { kind: "warming", code: "auth_cache_warming" };
    }
    const accessDisabled =
      auth.kind === "suspended" ||
      (auth.kind === "rejected" && auth.status === 403);
    return {
      kind: "denied",
      status: accessDisabled ? 403 : 401,
      code: accessDisabled ? "access_disabled" : "unauthorized",
    };
  }

  const scopePromise: Promise<
    Awaited<ReturnType<typeof appsService.getApiKeyOwningAppIdCacheOnly>>
  > = auth.ctx.apiKeyId
    ? appsService.getApiKeyOwningAppIdCacheOnly(auth.ctx.apiKeyId, {
        executionCtx,
      })
    : Promise.resolve({ kind: "ready", owningAppId: null });

  try {
    const [appResolution, scopeResolution, rateLimited] = await Promise.all([
      appsService.getByIdCacheOnly(appId, { executionCtx }),
      scopePromise,
      enforceOrgRateLimit(auth.ctx.orgId, "standard", {
        cacheOnly: true,
        executionCtx,
      }),
    ]);

    if (rateLimited) {
      return {
        kind: "rate_limited",
        status: rateLimited.status === 429 ? 429 : 503,
        retryAfter: rateLimited.headers.get("Retry-After") ?? "1",
      };
    }
    if (appResolution.kind !== "ready") {
      return { kind: "warming", code: "app_cache_warming" };
    }
    if (scopeResolution.kind !== "ready") {
      return { kind: "warming", code: "app_scope_cache_warming" };
    }
    if (!appResolution.app) {
      return { kind: "denied", status: 404, code: "app_not_found" };
    }
    if (
      appResolution.app.organization_id !== auth.ctx.orgId ||
      isCrossAppKeyUsage({
        apiKeyId: auth.ctx.apiKeyId,
        owningAppId: scopeResolution.owningAppId,
        requestedAppId: appId,
      })
    ) {
      return { kind: "denied", status: 403, code: "access_denied" };
    }

    return {
      kind: "ready",
      context: {
        app: appResolution.app,
        organizationId: auth.ctx.orgId,
        userId: auth.ctx.userId,
        apiKeyId: auth.ctx.apiKeyId ?? null,
        authorization: auth.ctx.authorization,
        executionCtx,
      },
    };
  } catch (error) {
    if (error instanceof OrgRateLimitCacheNotReadyError) {
      return { kind: "warming", code: "rate_cache_warming" };
    }
    throw error;
  }
}

/**
 * Run token-priced provider work after exact rate, spend, and revocation checks.
 */
export async function runInteractiveTextGeneration<T extends { usage?: InteractiveTextUsage }>(
  params: InteractiveTextGenerationParams,
  dispatch: () => Promise<T>,
): Promise<T> {
  const provider = getProviderFromModel(params.model);
  const billingSource = resolveAiProviderSource(params.model) ?? "gateway";
  const requestId = crypto.randomUUID();
  const admission = await admitOrganizationInference({
    context: {
      organizationId: params.identity.organizationId,
      userId: params.identity.userId,
      apiKeyId: params.identity.apiKeyId,
      requestId,
      model: params.model,
      provider,
      billingSource,
      description: params.description,
      metadata: params.metadata,
    },
    apiKeyId: params.identity.apiKeyId,
    estimatedInputTokens: estimateTokens(
      [params.systemPrompt, params.userPrompt].filter(Boolean).join("\n"),
    ),
    estimatedOutputTokens: params.maxOutputTokens,
    authorization: params.identity.authorization,
    executionCtx: params.identity.executionCtx,
  });

  let providerDispatchStarted = false;
  try {
    await admission.markProviderDispatched();
    providerDispatchStarted = true;
    const result = await dispatch();
    scheduledSettlement(params.identity, params.description, async () => {
      if (!result.usage) {
        await admission.settleUnknown();
        return;
      }
      try {
        const cost = await calculateCost(
          normalizeModelName(params.model),
          provider,
          result.usage.inputTokens ?? 0,
          result.usage.outputTokens ?? 0,
          billingSource,
        );
        await admission.settle(cost.totalCost);
      } catch (error) {
        await admission.settleUnknown();
        throw error;
      }
    });
    return result;
  } catch (error) {
    scheduledSettlement(params.identity, params.description, async () => {
      if (!providerDispatchStarted || isKnownUnacceptedProviderError(error)) {
        await admission.settle(0);
      } else {
        await admission.settleUnknown();
      }
    });
    throw error;
  }
}

function debitResult(
  actualCostUsd: number,
  outcome: Awaited<ReturnType<typeof debitInferenceCost>>,
): CreditReconciliationResult {
  return {
    reservedAmount: outcome.collectedAmountUsd,
    actualCost: actualCostUsd,
    collectedAmount: outcome.collectedAmountUsd,
    settlementTransactionIds: outcome.transactionId ? [outcome.transactionId] : [],
    adjustmentType:
      outcome.status === "collected" &&
      outcome.collectedAmountUsd + 0.000001 >= actualCostUsd
        ? "none"
        : "uncollected_overage",
  };
}

async function settleFixedCostLease(
  lease: InferenceAdmissionLease,
  params: InteractiveFixedCostGenerationParams,
  actualCostUsd: number,
): Promise<void> {
  const reconciliation =
    actualCostUsd <= 0
      ? {
          reservedAmount: 0,
          actualCost: 0,
          settlementTransactionIds: [],
          adjustmentType: "none" as const,
        }
      : debitResult(
          actualCostUsd,
          await debitInferenceCost(
            {
              requestId: lease.requestId,
              organizationId: params.identity.organizationId,
              userId: params.identity.userId,
              model: params.model,
              provider: params.provider,
              billingSource: params.billingSource,
            },
            actualCostUsd,
            "deferred",
          ),
        );
  const amounts = inferenceSettlementAmounts(
    lease,
    actualCostUsd,
    reconciliation,
  );
  await settleInferenceAdmissionLease(
    lease,
    amounts.balanceBackedUsd,
    amounts.gateConsumedUsd,
  );
}

/**
 * Run flat-priced generation (for example a promotion image) through the same
 * cache hint, Durable Object lease, final authorization check, and recovery
 * record as token-priced inference.
 */
export async function runInteractiveFixedCostGeneration<T>(
  params: InteractiveFixedCostGenerationParams,
  dispatch: () => Promise<T>,
): Promise<T> {
  const requestId = params.requestId ?? crypto.randomUUID();
  const estimatedCostUsd = Math.max(params.estimatedCostUsd, MIN_RESERVATION);
  const balanceHint = await getGateBalanceHint(params.identity.organizationId, {
    cacheOnly: true,
    executionCtx: params.identity.executionCtx,
  });
  if (balanceHint.balanceUsd < estimatedCostUsd) {
    throw new InsufficientCreditsError(
      estimatedCostUsd,
      balanceHint.balanceUsd,
      "cached_balance_gate",
    );
  }

  let lease: InferenceAdmissionLease;
  try {
    lease = await acquireInferenceAdmissionLease({
      organizationId: params.identity.organizationId,
      requestId,
      balanceUsd: balanceHint.balanceUsd,
      balanceRevision: balanceHint.balanceRevision,
      estimatedCostUsd,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId: params.identity.organizationId,
        requestId,
        userId: params.identity.userId,
        model: params.model,
        provider: params.provider,
        billingSource: params.billingSource,
        description: params.description,
        metadata: params.metadata,
        accounting: { kind: "direct_debit" },
      },
      authorization: params.identity.authorization,
      executionCtx: params.identity.executionCtx,
    });
  } catch (error) {
    if (error instanceof InferenceAdmissionLeaseRejectedError) {
      throw new InsufficientCreditsError(
        error.requiredUsd,
        error.availableUsd,
        "cached_balance_gate",
      );
    }
    if (error instanceof InferenceAdmissionGateUnavailableError) {
      throw new InferenceBalanceCacheWarmingError();
    }
    throw error;
  }

  let providerDispatchStarted = false;
  try {
    await markInferenceAdmissionLeaseDispatched(lease);
    providerDispatchStarted = true;
    const result = await dispatch();
    scheduledSettlement(params.identity, params.description, () =>
      settleFixedCostLease(lease, params, params.estimatedCostUsd),
    );
    return result;
  } catch (error) {
    scheduledSettlement(params.identity, params.description, () =>
      settleFixedCostLease(
        lease,
        params,
        !providerDispatchStarted || isKnownUnacceptedProviderError(error)
          ? 0
          : params.estimatedCostUsd,
      ),
    );
    throw error;
  }
}
