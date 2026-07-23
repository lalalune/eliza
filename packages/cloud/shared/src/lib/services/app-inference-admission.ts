/**
 * Cache-gated admission for monetized-app inference in Workers.
 *
 * The request promise reads only the organization balance hint. The existing
 * atomic app reservation, creator-earnings accounting, and reconciliation run
 * under `waitUntil`; a definitive balance race retries the same authoritative
 * app accounting at actual cost so collection and creator earnings remain one
 * idempotent operation.
 */

import type { App } from "../../db/repositories/apps";
import { createCreditReservationSettler } from "../utils/credit-reservation";
import { logger } from "../utils/logger";
import { computeInferenceCharge, isAppMonetizationActive } from "./app-credit-math";
import { appCreditsService } from "./app-credits";
import {
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
  MIN_RESERVATION,
} from "./credits";
import {
  acquireInferenceAdmissionLease,
  collectedInferenceCost,
  InferenceAdmissionGateUnavailableError,
  type InferenceAdmissionLease,
  InferenceAdmissionLeaseRejectedError,
  settleInferenceAdmissionLease,
} from "./inference-admission-gate";
import { invalidateOrgBalanceHint, writeOrgBalanceHint } from "./inference-auth-cache";
import { clearOrgAdmissionRefused, markOrgAdmissionRefused } from "./inference-billing-deferred";
import {
  getGateBalanceHint,
  InferenceBalanceCacheWarmingError,
} from "./inference-billing-fast-path";

export interface AppInferenceAdmissionExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface AppInferenceAdmissionParams {
  app: App;
  appId: string;
  userId: string;
  organizationId: string;
  estimatedBaseCostUsd: number;
  description: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  requestId: string;
  model: string;
  provider: string;
  billingSource: string;
  affiliateCode?: string | null;
  executionCtx: AppInferenceAdmissionExecutionContext;
}

export interface AppInferenceAdmission {
  mode: "deferred_app_reservation";
  estimatedTotalCostUsd: number;
  settle(actualBaseCostUsd: number): Promise<CreditReconciliationResult | null>;
  settleUnknown(): Promise<CreditReconciliationResult | null>;
}

type AppReservationOutcome =
  | {
      kind: "reserved";
      reservation: CreditReservation;
      settle: ReturnType<typeof createCreditReservationSettler>;
    }
  | { kind: "refused"; error: InsufficientCreditsError };

/**
 * App markup and affiliate markup are separate cashable allocations. Until a
 * single atomic composite charge owns both splits, accepting both could mint
 * one payout without collecting the other.
 */
export class InferenceAppAffiliateUnsupportedError extends Error {
  constructor(readonly appId: string) {
    super("App monetization and affiliate attribution cannot be combined for one inference charge");
    this.name = "InferenceAppAffiliateUnsupportedError";
  }
}

/** Enforce the composite-allocation guard for Worker and non-Worker callers. */
export function assertInferenceAppAffiliateSupported(
  appId: string,
  affiliateCode: string | null | undefined,
): void {
  if (affiliateCode?.trim()) {
    throw new InferenceAppAffiliateUnsupportedError(appId);
  }
}

const balanceRefreshes = new Map<string, Promise<void>>();

function chargeForBaseCost(app: App, baseCostUsd: number): number {
  return computeInferenceCharge(baseCostUsd, {
    monetizationEnabled: isAppMonetizationActive(app),
    platformOffsetAmount: app.platform_offset_amount,
    purchaseSharePercentage: app.purchase_share_percentage,
    inferenceMarkupPercentage: app.inference_markup_percentage,
  }).totalCost;
}

function refreshBalanceHintAfterSettlement(organizationId: string): Promise<void> {
  const existing = balanceRefreshes.get(organizationId);
  if (existing) return existing;
  const balanceAt = Date.now();
  const refresh = creditsService
    .getOrganizationBalanceSnapshot(organizationId)
    .then(async (snapshot) => {
      await writeOrgBalanceHint(organizationId, snapshot.balanceUsd, balanceAt, snapshot.revision);
      clearOrgAdmissionRefused(organizationId);
    })
    .catch(async (error) => {
      markOrgAdmissionRefused(organizationId);
      let invalidationError: unknown;
      try {
        await invalidateOrgBalanceHint(organizationId);
      } catch (cause) {
        invalidationError = cause;
      }
      logger.warn("[AppInferenceAdmission] Balance-hint refresh failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (invalidationError !== undefined) {
        throw new AggregateError(
          [error, invalidationError],
          "Balance refresh and fail-closed invalidation both failed",
        );
      }
      // error-policy:J2 the database settlement is complete, but cache repair
      // must remain retryable before the refusal guard can be cleared.
      throw error;
    })
    .finally(() => {
      balanceRefreshes.delete(organizationId);
    });
  balanceRefreshes.set(organizationId, refresh);
  return refresh;
}

async function blockAppAdmissionAfterFailure(
  organizationId: string,
  failure: unknown,
): Promise<never> {
  markOrgAdmissionRefused(organizationId);
  try {
    await invalidateOrgBalanceHint(organizationId);
  } catch (invalidationError) {
    throw new AggregateError(
      [failure, invalidationError],
      "App accounting and fail-closed cache invalidation both failed",
    );
  }
  throw failure;
}

/** Test hook: isolate post-settlement cache refresh state between cases. */
export function __clearAppInferenceAdmissionStateForTests(): void {
  balanceRefreshes.clear();
}

/**
 * Admit a monetized-app request from cached money state only.
 *
 * A full balance-cache miss throws `InferenceBalanceCacheWarmingError` through
 * `getGateBalanceHint`, after registering its authoritative hydration. A cached
 * insufficient balance throws the same typed 402 error as synchronous app
 * reservation without starting model work.
 */
export async function admitAppInferenceCacheOnly(
  params: AppInferenceAdmissionParams,
): Promise<AppInferenceAdmission> {
  assertInferenceAppAffiliateSupported(params.appId, params.affiliateCode);

  const reservedBaseCostUsd = Math.max(params.estimatedBaseCostUsd, MIN_RESERVATION);
  const estimatedTotalCostUsd = chargeForBaseCost(params.app, reservedBaseCostUsd);
  const balanceHint = await getGateBalanceHint(params.organizationId, {
    cacheOnly: true,
    executionCtx: params.executionCtx,
  });
  if (balanceHint.balanceUsd < estimatedTotalCostUsd) {
    throw new InsufficientCreditsError(
      estimatedTotalCostUsd,
      balanceHint.balanceUsd,
      "cached_balance_gate",
    );
  }
  const leaseCostUsd = Math.max(estimatedTotalCostUsd, MIN_RESERVATION);
  let inferenceLease: InferenceAdmissionLease;
  try {
    inferenceLease = await acquireInferenceAdmissionLease({
      organizationId: params.organizationId,
      requestId: params.requestId,
      balanceUsd: balanceHint.balanceUsd,
      balanceRevision: balanceHint.balanceRevision,
      estimatedCostUsd: leaseCostUsd,
      executionCtx: params.executionCtx,
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

  const reservationOutcome: Promise<AppReservationOutcome> = Promise.resolve()
    .then(() =>
      appCreditsService.reserveInferenceCredits({
        appId: params.appId,
        userId: params.userId,
        organizationId: params.organizationId,
        estimatedBaseCost: params.estimatedBaseCostUsd,
        description: params.description,
        // One server request owns one provider dispatch. A client key cannot
        // dedupe money unless the provider response itself is replayed.
        idempotencyKey: params.requestId,
        retainChargeOnPostDebitFailure: true,
        metadata: params.metadata,
        app: params.app,
      }),
    )
    .then(
      (reservation): AppReservationOutcome => ({
        kind: "reserved",
        reservation,
        settle: createCreditReservationSettler(reservation),
      }),
      (error: unknown): AppReservationOutcome => {
        if (error instanceof InsufficientCreditsError) {
          return { kind: "refused", error };
        }
        // Keep infrastructure failures rejected: waitUntil observes them and
        // settlement receives the same unknown money outcome.
        throw error;
      },
    );
  params.executionCtx.waitUntil(reservationOutcome.then(() => undefined));

  let settlement: Promise<CreditReconciliationResult | null> | null = null;
  let firstActualBaseCostUsd: number | null = null;

  const settle = async (actualBaseCostUsd: number): Promise<CreditReconciliationResult | null> => {
    let outcome: AppReservationOutcome;
    try {
      outcome = await reservationOutcome;
    } catch (error) {
      return await blockAppAdmissionAfterFailure(params.organizationId, error);
    }
    if (outcome.kind === "reserved") {
      try {
        const reconciliation = await outcome.settle(actualBaseCostUsd);
        await refreshBalanceHintAfterSettlement(params.organizationId);
        return reconciliation;
      } catch (error) {
        return await blockAppAdmissionAfterFailure(params.organizationId, error);
      }
    }

    markOrgAdmissionRefused(params.organizationId);
    await invalidateOrgBalanceHint(params.organizationId);
    if (actualBaseCostUsd <= 0) {
      return {
        reservedAmount: 0,
        actualCost: 0,
        settlementTransactionIds: [],
        adjustmentType: "none",
      };
    }

    const actualTotalCostUsd = chargeForBaseCost(params.app, actualBaseCostUsd);
    logger.warn(
      "[AppInferenceAdmission] Deferred app reservation refused after forward; retrying authoritative app accounting at actual cost",
      {
        appId: params.appId,
        organizationId: params.organizationId,
        requestId: params.requestId,
        actualBaseCostUsd,
        actualTotalCostUsd,
      },
    );

    let fallbackReservation: CreditReservation;
    try {
      fallbackReservation = await appCreditsService.reserveInferenceCredits({
        appId: params.appId,
        userId: params.userId,
        organizationId: params.organizationId,
        estimatedBaseCost: actualBaseCostUsd,
        description: params.description,
        idempotencyKey: params.requestId,
        retainChargeOnPostDebitFailure: true,
        metadata: {
          ...params.metadata,
          deferredAppFallback: true,
        },
        app: params.app,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return {
          reservedAmount: 0,
          actualCost: actualTotalCostUsd,
          settlementTransactionIds: [],
          adjustmentType: "uncollected_overage",
        };
      }
      throw error;
    }

    const fallbackSettler = createCreditReservationSettler(fallbackReservation);
    try {
      const reconciliation = await fallbackSettler(actualBaseCostUsd);
      await refreshBalanceHintAfterSettlement(params.organizationId);
      return (
        reconciliation ?? {
          reservedAmount: fallbackReservation.reservedAmount,
          actualCost: actualTotalCostUsd,
          reservationTransactionId: fallbackReservation.reservationTransactionId,
          settlementTransactionIds: [],
          adjustmentType: "none",
        }
      );
    } catch (error) {
      return await blockAppAdmissionAfterFailure(params.organizationId, error);
    }
  };

  const settleTerminal = (
    actualBaseCostUsd: number,
  ): Promise<CreditReconciliationResult | null> => {
    if (firstActualBaseCostUsd === null) firstActualBaseCostUsd = actualBaseCostUsd;
    if (settlement) return settlement;
    const current = settle(firstActualBaseCostUsd).then(async (reconciliation) => {
      const actualTotalCostUsd =
        reconciliation?.actualCost ?? chargeForBaseCost(params.app, firstActualBaseCostUsd ?? 0);
      await settleInferenceAdmissionLease(
        inferenceLease,
        collectedInferenceCost(inferenceLease, actualTotalCostUsd, reconciliation),
      );
      return reconciliation;
    });
    settlement = current;
    current.then(
      () => undefined,
      () => {
        // error-policy:J5 the caller observes the original rejection; reset
        // only so a keyed settlement retry can heal its partial commit.
        if (settlement === current) settlement = null;
      },
    );
    return current;
  };

  return {
    mode: "deferred_app_reservation",
    estimatedTotalCostUsd,
    settle: settleTerminal,
    settleUnknown: () => settleTerminal(reservedBaseCostUsd),
  };
}
