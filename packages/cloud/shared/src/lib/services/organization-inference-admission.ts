/**
 * Cache-gated admission for organization-funded inference.
 *
 * The warm Worker path reads only pricing, affiliate-policy, and balance caches,
 * then owns durable admission under `waitUntil`. Ordinary requests use the
 * pending-charge ledger; affiliate requests retain their reservation-coupled
 * accounting without joining the response-facing promise.
 */

import { calculateCost, normalizeModelName } from "../pricing";
import { createCreditReservationSettler } from "../utils/credit-reservation";
import { logger } from "../utils/logger";
import type { AffiliateBillingAttribution } from "./affiliate-billing-attribution";
import type { BillingContext } from "./ai-billing";
import {
  getAffiliatePayoutSourceId,
  InsufficientCreditsError,
  reserveCredits,
} from "./ai-billing";
import { AiPricingCacheUnavailableError, AiPricingCacheWarmingError } from "./ai-pricing/cache";
import {
  COST_BUFFER,
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  MIN_RESERVATION,
} from "./credits";
import { AFFILIATE_PAYOUT_CONTRACT_VERSION } from "./affiliate-payout-outbox";
import {
  acquireInferenceAdmissionLease,
  collectedInferenceCost,
  InferenceAdmissionGateUnavailableError,
  type InferenceAdmissionLease,
  InferenceAdmissionLeaseRejectedError,
  settleInferenceAdmissionLease,
} from "./inference-admission-gate";
import {
  InferenceAffiliateCacheUnavailableError as AffiliateCacheUnavailableError,
  InferenceAffiliateCacheWarmingError as AffiliateCacheWarmingError,
  getCachedInferenceAffiliateAttribution,
} from "./inference-affiliate-cache";
import { invalidateOrgBalanceHint } from "./inference-auth-cache";
import {
  createDeferredAdmissionSettler,
  type DeferredAdmissionOutcome,
  isDeferredAdmissionEnabled,
  isOrgAdmissionRefused,
  markOrgAdmissionRefused,
} from "./inference-billing-deferred";
import {
  createOptimisticDebitSettler,
  type GateBalanceSnapshot,
  getGateBalanceHint,
  InferenceBalanceCacheWarmingError,
  isOptimisticBackstopAvailable,
  isOptimisticBillingEnabled,
  isOptimisticEligible,
  resolveSafeBalanceThresholdUsd,
  scheduleOrgBalanceHintHydration,
  writePendingInferenceCharge,
} from "./inference-billing-fast-path";
import {
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler,
  resolveInferenceBillingLedger,
} from "./inference-billing-ledger";

export type InferenceAdmissionMode =
  | "deferred_db_ledger"
  | "deferred_kv_ledger"
  | "deferred_reservation"
  | "synchronous_db_ledger"
  | "synchronous_kv_ledger"
  | "synchronous_reservation";

export interface OrganizationInferenceAdmission {
  mode: InferenceAdmissionMode;
  settle(actualCostUsd: number): Promise<CreditReconciliationResult | null>;
  /** Conservatively settle provider work whose exact usage is unavailable. */
  settleUnknown(): Promise<CreditReconciliationResult | null>;
  /**
   * Reservation-compatible view for accounting that must reconcile before a
   * payout. Affiliate billing passes this to `billUsage`, which then waits for
   * the same first-call settlement promise before minting earnings.
   */
  reservation?: CreditReservation;
  /** Immutable affiliate policy selected before provider dispatch. */
  affiliateAttribution?: AffiliateBillingAttribution | null;
}

export interface OrganizationInferenceAdmissionParams {
  context: BillingContext & {
    provider: string;
    billingSource: string;
    requestId: string;
  };
  apiKeyId?: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  affiliateCode?: string | null;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

/** Retryable signal preserving route compatibility while identifying pricing hydration. */
export class InferencePricingCacheWarmingError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AiPricingCacheWarmingError) {
    super();
    this.name = "InferencePricingCacheWarmingError";
  }
}

/** Retryable signal for a configured Worker cache that cannot serve pricing. */
export class InferencePricingCacheUnavailableError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AiPricingCacheUnavailableError) {
    super();
    this.name = "InferencePricingCacheUnavailableError";
  }
}

/** Retryable signal identifying a cold affiliate pricing-policy cache. */
export class InferenceAffiliateCacheWarmingError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AffiliateCacheWarmingError) {
    super();
    this.name = "InferenceAffiliateCacheWarmingError";
  }
}

/** Retryable signal for an affiliate policy cache that cannot serve safely. */
export class InferenceAffiliateCacheUnavailableError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AffiliateCacheUnavailableError) {
    super();
    this.name = "InferenceAffiliateCacheUnavailableError";
  }
}

/** The request cannot safely defer its durable charge in this Worker. */
export class InferenceAdmissionUnavailableError extends InferenceBalanceCacheWarmingError {
  constructor() {
    super();
    this.name = "InferenceAdmissionUnavailableError";
  }
}

async function reserveSynchronously(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  const reservation = await reserveCredits(
    {
      ...params.context,
      affiliateCode: params.affiliateCode ?? undefined,
    },
    params.estimatedInputTokens,
    params.estimatedOutputTokens,
  );
  const settle = createCreditReservationSettler(reservation);
  return {
    mode: "synchronous_reservation",
    settle,
    settleUnknown: () => settle(reservation.reservedAmount),
    affiliateAttribution: reservation.affiliateAttribution ?? null,
    reservation: {
      reservedAmount: reservation.reservedAmount,
      reservationTransactionId: reservation.reservationTransactionId,
      affiliateAttribution: reservation.affiliateAttribution ?? null,
      affiliatePayoutSourceId: reservation.affiliatePayoutSourceId ?? null,
      reconcile: async (actualCostUsd) => (await settle(actualCostUsd)) ?? undefined,
    },
  };
}

function attachInferenceAdmissionLease(
  admission: OrganizationInferenceAdmission,
  lease: InferenceAdmissionLease,
): OrganizationInferenceAdmission {
  const settleAuthoritatively = admission.settle;
  const settleUnknownAuthoritatively = admission.settleUnknown;
  type SettlementChoice =
    | { kind: "actual"; actualCostUsd: number }
    | { kind: "unknown" };
  let choice: SettlementChoice | undefined;
  let settlement: Promise<CreditReconciliationResult | null> | null = null;
  const run = (
    requestedChoice: SettlementChoice,
  ): Promise<CreditReconciliationResult | null> => {
    choice ??= requestedChoice;
    if (settlement) return settlement;
    const selected = choice;
    const authoritative =
      selected.kind === "actual"
        ? settleAuthoritatively(selected.actualCostUsd)
        : settleUnknownAuthoritatively();
    const current = authoritative.then(
      async (reconciliation) => {
        const actualCostUsd =
          selected.kind === "actual"
            ? selected.actualCostUsd
            : Math.max(
                lease.estimatedCostUsd,
                reconciliation?.actualCost ?? 0,
              );
        await settleInferenceAdmissionLease(
          lease,
          collectedInferenceCost(
            lease,
            actualCostUsd,
            reconciliation,
          ),
        );
        return reconciliation;
      },
    );
    settlement = current;
    current.then(
      () => undefined,
      () => {
        // error-policy:J5 the caller observes the settlement failure. Retrying
        // reuses authoritative idempotency and repairs the still-held lease.
        if (settlement === current) settlement = null;
      },
    );
    return current;
  };
  const settle = (
    actualCostUsd: number,
  ): Promise<CreditReconciliationResult | null> =>
    run({ kind: "actual", actualCostUsd });
  const settleUnknown = (): Promise<CreditReconciliationResult | null> =>
    run({ kind: "unknown" });
  if (admission.reservation) {
    admission.reservation.reconcile = async (actualCostUsd) =>
      (await settle(actualCostUsd)) ?? undefined;
  }
  return { ...admission, settle, settleUnknown };
}

/**
 * Admit one organization-credit inference request.
 *
 * Affiliate-marked Worker requests retain reservation-coupled accounting, but
 * their authoritative hold is deferred under `waitUntil`. Non-Worker callers
 * keep synchronous reservation compatibility.
 */
export async function admitOrganizationInference(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  const executionCtx = params.executionCtx;
  const workerHotPath = typeof executionCtx?.waitUntil === "function";
  const affiliateMarked = Boolean(params.affiliateCode?.trim());
  if (workerHotPath && executionCtx && isOrgAdmissionRefused(params.context.organizationId)) {
    // A prior deferred write or fallback charge was refused. Its settler
    // invalidated the balance hint, so a later retry will hydrate authoritative
    // state under waitUntil; this request must not bypass the refusal with a
    // synchronous database reserve on the model hot path.
    scheduleOrgBalanceHintHydration(params.context.organizationId, executionCtx);
    throw new InferenceAdmissionUnavailableError();
  }
  if (!workerHotPath && affiliateMarked) {
    return await reserveSynchronously(params);
  }
  if (!isOptimisticBillingEnabled()) {
    if (workerHotPath) throw new InferenceAdmissionUnavailableError();
    return await reserveSynchronously(params);
  }

  const thresholdUsd = resolveSafeBalanceThresholdUsd();
  const useDbLedger = resolveInferenceBillingLedger() === "db";
  const canDefer =
    isDeferredAdmissionEnabled() &&
    workerHotPath &&
    (affiliateMarked || useDbLedger || isOptimisticBackstopAvailable());
  if (workerHotPath && !canDefer) {
    throw new InferenceAdmissionUnavailableError();
  }

  const normalizedModel = normalizeModelName(params.context.model);
  let estimatedCostUsd: number;
  let balanceHint: GateBalanceSnapshot;
  let affiliateAttribution: AffiliateBillingAttribution | null = null;
  try {
    const [cost, gateBalance, resolvedAffiliateAttribution] = await Promise.all([
      calculateCost(
        normalizedModel,
        params.context.provider,
        params.estimatedInputTokens,
        params.estimatedOutputTokens,
        params.context.billingSource,
        {
          cacheOnly: canDefer,
          executionCtx: params.executionCtx,
        },
      ),
      getGateBalanceHint(params.context.organizationId, {
        executionCtx: params.executionCtx,
        cacheOnly: canDefer,
      }),
      affiliateMarked && params.executionCtx
        ? getCachedInferenceAffiliateAttribution({
            affiliateCode: params.affiliateCode,
            organizationId: params.context.organizationId,
            userId: params.context.userId,
            executionCtx: params.executionCtx,
          })
        : null,
    ]);
    affiliateAttribution = resolvedAffiliateAttribution;
    const affiliateMarkupPercent = affiliateAttribution?.markupPercent ?? 0;
    const markedUpEstimate = cost.totalCost * (1 + affiliateMarkupPercent);
    estimatedCostUsd = affiliateMarked
      ? Math.max(markedUpEstimate * COST_BUFFER, MIN_RESERVATION)
      : markedUpEstimate;
    balanceHint = gateBalance;
  } catch (error) {
    if (error instanceof AiPricingCacheWarmingError) {
      throw new InferencePricingCacheWarmingError(error);
    }
    if (error instanceof AiPricingCacheUnavailableError) {
      throw new InferencePricingCacheUnavailableError(error);
    }
    if (error instanceof AffiliateCacheWarmingError) {
      throw new InferenceAffiliateCacheWarmingError(error);
    }
    if (error instanceof AffiliateCacheUnavailableError) {
      throw new InferenceAffiliateCacheUnavailableError(error);
    }
    throw error;
  }

  if (
    !isOptimisticEligible({
      enabled: true,
      useAppCredits: false,
      balanceUsd: balanceHint.balanceUsd,
      thresholdUsd,
      estimatedCostUsd,
    })
  ) {
    if (canDefer) {
      throw new InsufficientCreditsError(
        estimatedCostUsd,
        balanceHint.balanceUsd,
        "cached_balance_gate",
      );
    }
    return await reserveSynchronously(params);
  }

  let inferenceLease: InferenceAdmissionLease | undefined;
  if (canDefer && params.executionCtx) {
    try {
      inferenceLease = await acquireInferenceAdmissionLease({
        organizationId: params.context.organizationId,
        requestId: params.context.requestId,
        balanceUsd: balanceHint.balanceUsd,
        balanceRevision: balanceHint.balanceRevision,
        estimatedCostUsd: Math.max(estimatedCostUsd, MIN_RESERVATION),
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
        throw new InferenceAdmissionUnavailableError();
      }
      throw error;
    }
  }

  const charge = {
    requestId: params.context.requestId,
    organizationId: params.context.organizationId,
    userId: params.context.userId,
    apiKeyId: params.apiKeyId ?? params.context.apiKeyId ?? null,
    model: params.context.model,
    provider: params.context.provider,
    billingSource: params.context.billingSource,
  };
  const debit = {
    requestId: charge.requestId,
    organizationId: charge.organizationId,
    userId: charge.userId,
    model: charge.model,
    provider: charge.provider,
    billingSource: charge.billingSource,
  };

  if (affiliateMarked && canDefer && params.executionCtx) {
    const affiliatePayoutSourceId = affiliateAttribution
      ? getAffiliatePayoutSourceId(params.context)
      : null;
    const affiliatePayoutMetadata =
      affiliateAttribution && affiliatePayoutSourceId
        ? {
            affiliatePayout: {
              version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
              sourceId: affiliatePayoutSourceId,
              attribution: affiliateAttribution,
              model: params.context.model,
            },
          }
        : null;
    let reservationSettler:
      | ((actualCostUsd: number) => Promise<CreditReconciliationResult | null>)
      | null = null;
    let settle!: (actualCostUsd: number) => Promise<CreditReconciliationResult | null>;
    const reservationView: CreditReservation = {
      reservedAmount: estimatedCostUsd,
      reservationTransactionId: null,
      affiliateAttribution,
      affiliatePayoutSourceId,
      reconcile: async (actualCostUsd) => (await settle(actualCostUsd)) ?? undefined,
    };
    const deferredStart = new Promise<void>((resolve) => setTimeout(resolve, 0));
    const admission: Promise<DeferredAdmissionOutcome> = deferredStart
      .then(() =>
        reserveCredits(
          {
            ...params.context,
            affiliateCode: params.affiliateCode ?? undefined,
            affiliateAttribution,
          },
          params.estimatedInputTokens,
          params.estimatedOutputTokens,
        ),
      )
      .then(
        (reservation) => {
          if (
            affiliatePayoutSourceId &&
            reservation.affiliatePayoutSourceId !== affiliatePayoutSourceId
          ) {
            throw new Error("Deferred affiliate reservation changed payout identity");
          }
          reservationSettler = createCreditReservationSettler(reservation);
          reservationView.reservedAmount = reservation.reservedAmount;
          reservationView.reservationTransactionId = reservation.reservationTransactionId ?? null;
          reservationView.affiliateAttribution = reservation.affiliateAttribution ?? null;
          reservationView.affiliatePayoutSourceId =
            reservation.affiliatePayoutSourceId ?? null;
          return { admitted: true };
        },
        async (error) => {
          if (error instanceof InsufficientCreditsError) {
            // error-policy:J1 a definitive balance refusal can safely use the
            // idempotent actual-cost fallback after model completion.
            logger.warn("[InferenceBilling] deferred affiliate reservation refused", {
              requestId: charge.requestId,
              organizationId: charge.organizationId,
              required: error.required,
              available: error.available,
            });
            return { admitted: false };
          }
          // An infrastructure failure has an unknown money outcome. Block the
          // next dispatch before preserving the rejection; retrying against a
          // stale-high hint could repeat an already-committed reservation.
          markOrgAdmissionRefused(charge.organizationId);
          try {
            await invalidateOrgBalanceHint(charge.organizationId);
          } catch (invalidationError) {
            // error-policy:J7 the isolate-local refusal remains authoritative;
            // log cache eviction separately while retaining the money failure.
            logger.error(
              "[InferenceBilling] failed to invalidate balance after affiliate reservation failure",
              {
                requestId: charge.requestId,
                organizationId: charge.organizationId,
                error:
                  invalidationError instanceof Error
                    ? invalidationError.message
                    : String(invalidationError),
              },
            );
          }
          throw error;
        },
      );
    params.executionCtx.waitUntil(admission);
    settle = createDeferredAdmissionSettler({
      admission,
      onAdmitted: (actualCostUsd) => {
        if (!reservationSettler) {
          throw new Error("Deferred affiliate reservation admitted without a settlement handle");
        }
        return reservationSettler(actualCostUsd);
      },
      fallback: debit,
      ...(affiliatePayoutMetadata && {
        onRefused: (actualCostUsd: number) =>
          creditsService.collectAffiliateInferenceFallback({
            organizationId: charge.organizationId,
            userId: charge.userId,
            requestId: charge.requestId,
            model: charge.model,
            provider: charge.provider,
            billingSource: charge.billingSource,
            actualCost: actualCostUsd,
            reservationMetadata: affiliatePayoutMetadata,
          }),
      }),
    });
    const result: OrganizationInferenceAdmission = {
      mode: "deferred_reservation",
      settle,
      settleUnknown: () => settle(estimatedCostUsd),
      reservation: reservationView,
      affiliateAttribution,
    };
    return inferenceLease ? attachInferenceAdmissionLease(result, inferenceLease) : result;
  }

  if (canDefer && params.executionCtx) {
    const admission: Promise<DeferredAdmissionOutcome> = useDbLedger
      ? admitInferenceChargeViaLedger({
          charge,
          estimatedCostUsd,
          thresholdUsd,
        })
      : writePendingInferenceCharge({ ...charge, estimatedCostUsd }, Date.now()).then(
          (admitted) => ({ admitted }),
        );
    params.executionCtx.waitUntil(admission);
    const settle = createDeferredAdmissionSettler({
      admission,
      onAdmitted: useDbLedger
        ? createLedgerDebitSettler(charge)
        : createOptimisticDebitSettler(debit),
      fallback: debit,
    });
    const result: OrganizationInferenceAdmission = {
      mode: useDbLedger ? "deferred_db_ledger" : "deferred_kv_ledger",
      settle,
      settleUnknown: () => settle(estimatedCostUsd),
    };
    return inferenceLease ? attachInferenceAdmissionLease(result, inferenceLease) : result;
  }

  if (useDbLedger) {
    const admission = await admitInferenceChargeViaLedger({
      charge,
      estimatedCostUsd,
      thresholdUsd,
    });
    if (admission.admitted) {
      const settle = createLedgerDebitSettler(charge);
      return {
        mode: "synchronous_db_ledger",
        settle,
        settleUnknown: () => settle(estimatedCostUsd),
      };
    }
    return await reserveSynchronously(params);
  }

  if (isOptimisticBackstopAvailable()) {
    const admitted = await writePendingInferenceCharge({ ...charge, estimatedCostUsd }, Date.now());
    if (admitted) {
      const settle = createOptimisticDebitSettler(debit);
      return {
        mode: "synchronous_kv_ledger",
        settle,
        settleUnknown: () => settle(estimatedCostUsd),
      };
    }
  }

  return await reserveSynchronously(params);
}
