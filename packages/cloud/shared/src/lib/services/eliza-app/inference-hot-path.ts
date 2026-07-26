/**
 * Serialized rate, spend, authorization, and settlement for Eliza App text.
 *
 * Both interactive Eliza App routes use this wrapper so the only work before
 * Cerebras is cached policy plus the organization Durable Object. Exact
 * provider cost is reconciled under waitUntil after the response path.
 */

import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "../../pricing";
import { logger } from "../../utils/logger";
import { settleOffResponsePath } from "../../utils/settle-off-response-path";
import {
  consumeInferenceRateLimit,
  InferenceAdmissionGateUnavailableError,
} from "../inference-admission-gate";
import {
  getOrgRpmForEndpointCacheOnly,
  type OrgTierCacheExecutionContext,
} from "../org-rate-limits";
import {
  admitOrganizationInference,
  type OrganizationInferenceAdmission,
} from "../organization-inference-admission";
import type { ElizaAppInferenceIdentity } from "./inference-session-auth";

const PROVIDER = "cerebras";
const BILLING_SOURCE = "cerebras";

export class ElizaAppInferenceWarmingError extends Error {
  constructor(readonly boundary: "rate_limit" | "billing") {
    super(`Eliza App inference ${boundary} cache is warming`);
    this.name = "ElizaAppInferenceWarmingError";
  }
}

export class ElizaAppInferenceRateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super("Eliza App inference rate limit exceeded");
    this.name = "ElizaAppInferenceRateLimitError";
  }
}

/** Provider transport/model failure after the strong dispatch marker landed. */
export class ElizaAppProviderCallError extends Error {
  constructor(readonly cause: unknown) {
    super("Eliza App text provider call failed", { cause });
    this.name = "ElizaAppProviderCallError";
  }
}

export interface ElizaAppTextUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ElizaAppTextResult {
  text: string;
  usage?: ElizaAppTextUsage;
}

async function admit(params: {
  identity: ElizaAppInferenceIdentity;
  model: string;
  requestId: string;
  promptText: string;
  maxOutputTokens: number;
  description: string;
  executionCtx: OrgTierCacheExecutionContext;
}): Promise<OrganizationInferenceAdmission> {
  const ratePolicy = await getOrgRpmForEndpointCacheOnly(
    params.identity.organizationId,
    "completions",
    { executionCtx: params.executionCtx },
  );
  if (ratePolicy.kind !== "ready") {
    throw new ElizaAppInferenceWarmingError("rate_limit");
  }
  let rate;
  try {
    rate = await consumeInferenceRateLimit({
      organizationId: params.identity.organizationId,
      endpointType: "completions",
      windowMs: ratePolicy.config.windowMs,
      maxRequests: ratePolicy.config.maxRequests,
    });
  } catch (error) {
    if (error instanceof InferenceAdmissionGateUnavailableError) {
      throw new ElizaAppInferenceWarmingError("rate_limit");
    }
    throw error;
  }
  if (!rate.allowed) {
    throw new ElizaAppInferenceRateLimitError(rate.retryAfter ?? 1);
  }

  try {
    return await admitOrganizationInference({
      context: {
        organizationId: params.identity.organizationId,
        userId: params.identity.userId,
        model: params.model,
        provider: getProviderFromModel(params.model),
        billingSource: BILLING_SOURCE,
        requestId: params.requestId,
        description: params.description,
      },
      estimatedInputTokens: estimateTokens(params.promptText),
      estimatedOutputTokens: params.maxOutputTokens,
      authorization: params.identity.authorization,
      executionCtx: params.executionCtx,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name.includes("CacheWarming") ||
        error.name.includes("CacheUnavailable") ||
        error.name.includes("AdmissionUnavailable"))
    ) {
      throw new ElizaAppInferenceWarmingError("billing");
    }
    throw error;
  }
}

function settleUnknown(
  executionCtx: OrgTierCacheExecutionContext,
  admission: OrganizationInferenceAdmission,
  context: Record<string, string>,
): void {
  void settleOffResponsePath(executionCtx, async () => {
    try {
      await admission.settleUnknown();
    } catch (error) {
      // error-policy:J7 the DO lease/alarm remains the recovery source; keep
      // a failed post-provider settlement visible for operators.
      logger.error("[ElizaAppInference] Conservative settlement failed", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function settleUsage(
  executionCtx: OrgTierCacheExecutionContext,
  admission: OrganizationInferenceAdmission,
  model: string,
  usage: ElizaAppTextUsage | undefined,
  context: Record<string, string>,
): void {
  if (!usage || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
    settleUnknown(executionCtx, admission, context);
    return;
  }
  void settleOffResponsePath(executionCtx, async () => {
    try {
      const cost = await calculateCost(
        normalizeModelName(model),
        PROVIDER,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        BILLING_SOURCE,
      );
      await admission.settle(cost.totalCost);
    } catch (error) {
      try {
        await admission.settleUnknown();
      } catch (settlementError) {
        // error-policy:J7 the lease alarm owns recovery if both exact and
        // conservative settlement attempts fail after provider work.
        logger.error("[ElizaAppInference] Exact settlement failed", {
          ...context,
          error: error instanceof Error ? error.message : String(error),
          settlementError:
            settlementError instanceof Error ? settlementError.message : String(settlementError),
        });
        return;
      }
      logger.warn("[ElizaAppInference] Exact pricing failed; settled conservatively", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Execute one provider call after the final strong dispatch transition.
 */
export async function runElizaAppTextInference<T extends ElizaAppTextResult>(params: {
  identity: ElizaAppInferenceIdentity;
  model: string;
  requestId: string;
  promptText: string;
  maxOutputTokens: number;
  description: string;
  executionCtx: OrgTierCacheExecutionContext;
  dispatch(): Promise<T>;
}): Promise<T> {
  const admission = await admit(params);
  const context = {
    organizationId: params.identity.organizationId,
    userId: params.identity.userId,
    requestId: params.requestId,
    model: params.model,
  };
  try {
    await admission.markProviderDispatched();
  } catch (error) {
    void settleOffResponsePath(params.executionCtx, async () => {
      try {
        await admission.settle(0);
      } catch (settlementError) {
        // error-policy:J7 a dispatch failure never invokes the provider; this
        // release failure remains observable and the lease alarm is bounded.
        logger.error("[ElizaAppInference] Pre-provider lease release failed", {
          ...context,
          error:
            settlementError instanceof Error ? settlementError.message : String(settlementError),
        });
      }
    });
    throw error;
  }

  let result: T;
  try {
    result = await params.dispatch();
  } catch (error) {
    settleUnknown(params.executionCtx, admission, context);
    throw new ElizaAppProviderCallError(error);
  }
  settleUsage(params.executionCtx, admission, params.model, result.usage, context);
  return result;
}
