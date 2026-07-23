/**
 * Proves Worker organization admission reads only cached pricing and balance.
 *
 * The real pricing lookup runs against repository/catalog tripwires: a cold
 * request must reject before those reads finish, while the retry after its
 * `waitUntil` hydration performs zero authoritative pricing calls.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";

type PairFilters = {
  billingSource?: string;
  productFamily: string;
  chargeType: "input" | "output";
  pairs: Array<{ provider: string; model: string }>;
};

let pairReads = 0;
let fallbackReads = 0;
let catalogReads = 0;
let affiliateReads = 0;
let repositoryBlock: Promise<void> | null = null;
let affiliateRepositoryBlock: Promise<void> | null = null;

function catalogRow(filters: PairFilters) {
  const pair = filters.pairs[0];
  if (!pair) throw new Error("pricing lookup did not provide a provider/model pair");
  return {
    billing_source: filters.billingSource ?? "bitrouter",
    provider: pair.provider,
    model: pair.model,
    product_family: filters.productFamily,
    charge_type: filters.chargeType,
    unit: "token",
    unit_price: filters.chargeType === "input" ? "0.000001" : "0.000004",
    dimensions: {},
    source_kind: "test_catalog",
    source_url: "https://pricing.example.test",
    fetched_at: new Date(),
    stale_after: null,
    priority: 200,
    is_override: false,
    metadata: {},
  };
}

const listActiveEntriesForProviderModelPairs = mock(async (filters: PairFilters) => {
  pairReads++;
  if (repositoryBlock) await repositoryBlock;
  return [catalogRow(filters)];
});
const listActiveEntries = mock(async () => {
  fallbackReads++;
  return [];
});
const fetchEntriesForSource = mock(async () => {
  catalogReads++;
  return [];
});
const getAffiliateCodeByCode = mock(async (code: string) => {
  affiliateReads++;
  if (affiliateRepositoryBlock) await affiliateRepositoryBlock;
  return {
    id: `affiliate-${code}`,
    user_id: "affiliate-owner",
    code,
    parent_referral_id: null,
    markup_percent: "20.00",
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
});

mock.module("../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs,
    listActiveEntries,
  },
}));
mock.module("./ai-pricing/providers/gateway", () => ({
  fetchEntriesForSource,
}));
mock.module("../../db/repositories/affiliates", () => ({
  affiliatesRepository: {
    getAffiliateCodeByCode,
  },
}));

let reservationBlock: Promise<void> | null = null;
let reservationError: Error | null = null;
const reconcileReservation = mock(async () => null);
const reserveCredits = mock(async (context: {
  requestId?: string | null;
  affiliateAttribution?: {
    affiliateCodeId: string;
    affiliateUserId: string;
    affiliateCode: string;
    markupPercent: number;
  } | null;
}) => {
  if (reservationBlock) await reservationBlock;
  if (reservationError) throw reservationError;
  return {
    reservedAmount: 0.01,
    reservationTransactionId: "reservation",
    affiliateAttribution: context.affiliateAttribution ?? null,
    affiliatePayoutSourceId: context.affiliateAttribution
      ? `ai_billing:affiliate:${context.requestId}`
      : null,
    reconcile: reconcileReservation,
  };
});
const writePendingInferenceCharge = mock(async () => true);
const optimisticSettle = mock(async () => null);
const deferredSettle = mock(async () => null);
let gateBalance = 50;
let eligible = true;
let orgRefused = false;
const acquireInferenceAdmissionLease = mock(
  async (params: { organizationId: string; requestId: string; estimatedCostUsd: number }) => ({
    organizationId: params.organizationId,
    requestId: params.requestId,
    estimatedCostUsd: params.estimatedCostUsd,
    gate: { fetch: async () => Response.json({ settled: true }) },
  }),
);
const settleInferenceAdmissionLease = mock(async () => undefined);

mock.module("./ai-billing", () => ({
  reserveCredits,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    constructor(
      readonly required: number,
      readonly available: number,
      readonly reason?: string,
    ) {
      super("insufficient");
      this.name = "InsufficientCreditsError";
    }
  },
}));
mock.module("../utils/credit-reservation", () => ({
  createCreditReservationSettler: () => optimisticSettle,
}));
mock.module("./inference-billing-fast-path", () => ({
  InferenceBalanceCacheWarmingError: class InferenceBalanceCacheWarmingError extends Error {
    constructor() {
      super("warming");
      this.name = "InferenceBalanceCacheWarmingError";
    }
  },
  createOptimisticDebitSettler: () => optimisticSettle,
  getGateBalanceHint: async () => ({
    balanceUsd: gateBalance,
    balanceAt: Date.now(),
    balanceRevision: "1",
  }),
  isOptimisticBackstopAvailable: () => true,
  isOptimisticBillingEnabled: () => true,
  isOptimisticEligible: () => eligible,
  resolveSafeBalanceThresholdUsd: () => 5,
  scheduleOrgBalanceHintHydration: (
    _organizationId: string,
    executionCtx: { waitUntil(promise: Promise<unknown>): void },
  ) => executionCtx.waitUntil(Promise.resolve()),
  writePendingInferenceCharge,
}));
mock.module("./inference-admission-gate", () => ({
  acquireInferenceAdmissionLease,
  collectedInferenceCost: (_lease: unknown, actualCostUsd: number) => actualCostUsd,
  InferenceAdmissionGateUnavailableError: class InferenceAdmissionGateUnavailableError extends Error {},
  InferenceAdmissionLeaseRejectedError: class InferenceAdmissionLeaseRejectedError extends Error {
    readonly requiredUsd = 1;
    readonly availableUsd = 0;
  },
  settleInferenceAdmissionLease,
}));
mock.module("./inference-billing-ledger", () => ({
  admitInferenceChargeViaLedger: async () => ({ admitted: true }),
  createLedgerDebitSettler: () => optimisticSettle,
  resolveInferenceBillingLedger: () => "kv",
}));
mock.module("./inference-billing-deferred", () => ({
  createDeferredAdmissionSettler: () => deferredSettle,
  isDeferredAdmissionEnabled: () => true,
  isOrgAdmissionRefused: () => orgRefused,
  markOrgAdmissionRefused: () => {
    orgRefused = true;
  },
}));

const {
  admitOrganizationInference,
  InferencePricingCacheWarmingError,
  InferencePricingCacheUnavailableError,
} = await import("./organization-inference-admission");
const { __clearPersistedPricingCache } = await import("./ai-pricing/cache");
const { __clearInferenceAffiliateCacheState } = await import("./inference-affiliate-cache");

let modelSequence = 0;
function nextModel(): string {
  modelSequence++;
  return `cerebras:pricing-hotpath-${modelSequence}`;
}

function admissionParams(
  model: string,
  background: Promise<unknown>[],
  overrides: { affiliateCode?: string } = {},
) {
  return {
    context: {
      organizationId: "org-1",
      userId: "user-1",
      model,
      provider: "cerebras",
      billingSource: "bitrouter",
      requestId: `request-${modelSequence}`,
    },
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    },
    ...overrides,
  };
}

async function hydratePricing(model: string): Promise<void> {
  const background: Promise<unknown>[] = [];
  const error = await admitOrganizationInference(admissionParams(model, background)).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(
    error instanceof InferencePricingCacheWarmingError ||
      error instanceof InferencePricingCacheUnavailableError,
  ).toBe(true);
  expect(background).toHaveLength(1);
  await background[0];
}

beforeEach(() => {
  __clearPersistedPricingCache();
  gateBalance = 50;
  eligible = true;
  orgRefused = false;
  repositoryBlock = null;
  affiliateRepositoryBlock = null;
  reservationBlock = null;
  reservationError = null;
  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  affiliateReads = 0;
  __clearInferenceAffiliateCacheState();
  reserveCredits.mockClear();
  reconcileReservation.mockClear();
  writePendingInferenceCharge.mockClear();
  optimisticSettle.mockClear();
  deferredSettle.mockClear();
  acquireInferenceAdmissionLease.mockClear();
  settleInferenceAdmissionLease.mockClear();
  listActiveEntriesForProviderModelPairs.mockClear();
  listActiveEntries.mockClear();
  fetchEntriesForSource.mockClear();
  getAffiliateCodeByCode.mockClear();
});

afterEach(() => {
  setSystemTime();
});

test("cold pricing rejects immediately and owns authoritative hydration under waitUntil", async () => {
  const model = nextModel();
  const releaseRepository = Promise.withResolvers<void>();
  repositoryBlock = releaseRepository.promise;
  const background: Promise<unknown>[] = [];

  const outcome = await Promise.race([
    admitOrganizationInference(admissionParams(model, background)).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 100),
    ),
  ]);

  expect(outcome.kind).toBe("rejected");
  if (outcome.kind !== "rejected") throw new Error("cold admission joined pricing hydration");
  expect(
    outcome.error instanceof InferencePricingCacheWarmingError ||
      outcome.error instanceof InferencePricingCacheUnavailableError,
  ).toBe(true);
  expect(background).toHaveLength(1);
  expect(reserveCredits).not.toHaveBeenCalled();

  releaseRepository.resolve();
  await background[0];
  expect(pairReads).toBe(2);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
});

test("warm deferred admission performs zero repository or provider-catalog calls", async () => {
  const model = nextModel();
  await hydratePricing(model);
  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  listActiveEntriesForProviderModelPairs.mockClear();
  listActiveEntries.mockClear();
  fetchEntriesForSource.mockClear();

  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(admissionParams(model, background));

  expect(admission.mode).toBe("deferred_kv_ledger");
  expect(background).toHaveLength(1);
  await background[0];
  expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
  expect(pairReads).toBe(0);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
  expect(reserveCredits).not.toHaveBeenCalled();
  await admission.settle(0.01);
  expect(deferredSettle).toHaveBeenCalledWith(0.01);
});

test("unknown provider cost retains the admitted estimate and wins a later zero settlement", async () => {
  const model = nextModel();
  await hydratePricing(model);
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(admissionParams(model, background));
  const leaseParams = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
    | { estimatedCostUsd: number }
    | undefined;
  if (!leaseParams) throw new Error("expected inference admission lease");

  const unknown = admission.settleUnknown();
  const laterZero = admission.settle(0);

  await expect(unknown).resolves.toBeNull();
  await expect(laterZero).resolves.toBeNull();
  expect(deferredSettle).toHaveBeenCalledTimes(1);
  expect(deferredSettle).toHaveBeenCalledWith(leaseParams.estimatedCostUsd);
  expect(settleInferenceAdmissionLease).toHaveBeenCalledTimes(1);
  expect(settleInferenceAdmissionLease.mock.calls[0]?.[1]).toBeCloseTo(
    leaseParams.estimatedCostUsd,
  );
});

test("stale pricing serves immediately and refreshes only under waitUntil", async () => {
  const baseTime = new Date("2026-07-23T12:00:00.000Z");
  setSystemTime(baseTime);
  const model = nextModel();
  await hydratePricing(model);
  pairReads = 0;
  const releaseRepository = Promise.withResolvers<void>();
  repositoryBlock = releaseRepository.promise;
  setSystemTime(new Date(baseTime.getTime() + 61_000));
  const background: Promise<unknown>[] = [];

  const outcome = await Promise.race([
    admitOrganizationInference(admissionParams(model, background)).then((admission) => ({
      kind: "resolved" as const,
      admission,
    })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 100),
    ),
  ]);

  expect(outcome.kind).toBe("resolved");
  if (outcome.kind !== "resolved") throw new Error("stale admission joined pricing refresh");
  expect(outcome.admission.mode).toBe("deferred_kv_ledger");
  expect(background).toHaveLength(2);
  expect(reserveCredits).not.toHaveBeenCalled();

  releaseRepository.resolve();
  await Promise.all(background);
  expect(pairReads).toBe(2);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
});

test("cached low balance rejects without a database reservation", async () => {
  const model = nextModel();
  await hydratePricing(model);
  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  gateBalance = 0.001;
  eligible = false;
  const background: Promise<unknown>[] = [];

  await expect(
    admitOrganizationInference(admissionParams(model, background)),
  ).rejects.toMatchObject({
    name: "InsufficientCreditsError",
    available: 0.001,
    reason: "cached_balance_gate",
  });
  expect(background).toHaveLength(0);
  expect(pairReads).toBe(0);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
  expect(reserveCredits).not.toHaveBeenCalled();
});

test("a previously refused org fails closed and hydrates balance off path", async () => {
  orgRefused = true;
  const background: Promise<unknown>[] = [];

  await expect(
    admitOrganizationInference(admissionParams(nextModel(), background)),
  ).rejects.toMatchObject({
    name: "InferenceAdmissionUnavailableError",
  });
  expect(background).toHaveLength(1);
  expect(pairReads).toBe(0);
  expect(affiliateReads).toBe(0);
  expect(reserveCredits).not.toHaveBeenCalled();
});

test("cold affiliate pricing hydrates policy and model rates without a synchronous reserve", async () => {
  const model = nextModel();
  const background: Promise<unknown>[] = [];

  const error = await admitOrganizationInference(
    admissionParams(model, background, { affiliateCode: `PARTNER-${modelSequence}` }),
  ).then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(Error);
  expect(background).toHaveLength(2);
  expect(reserveCredits).not.toHaveBeenCalled();
  await Promise.all(background);
  expect(pairReads).toBe(2);
  expect(affiliateReads).toBe(1);
});

test("warm Worker affiliate admission has zero pre-dispatch repository calls", async () => {
  const model = nextModel();
  const affiliateCode = `PARTNER-${modelSequence}`;
  const coldBackground: Promise<unknown>[] = [];
  await admitOrganizationInference(admissionParams(model, coldBackground, { affiliateCode })).then(
    () => null,
    () => null,
  );
  await Promise.all(coldBackground);

  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  affiliateReads = 0;
  reserveCredits.mockClear();
  const releaseReservation = Promise.withResolvers<void>();
  reservationBlock = releaseReservation.promise;
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(
    admissionParams(model, background, { affiliateCode }),
  );

  expect(admission.mode).toBe("deferred_reservation");
  expect(reserveCredits).not.toHaveBeenCalled();
  expect(background).toHaveLength(1);
  expect(pairReads).toBe(0);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
  expect(affiliateReads).toBe(0);

  releaseReservation.resolve();
  await background[0];
  expect(reserveCredits).toHaveBeenCalledTimes(1);
  expect(reserveCredits.mock.calls[0]?.[0]).toMatchObject({
    affiliateCode,
    affiliateAttribution: {
      affiliateCodeId: `affiliate-${affiliateCode}`,
      affiliateUserId: "affiliate-owner",
      affiliateCode,
      markupPercent: 0.2,
    },
  });
  expect(admission.reservation).toBeDefined();
  expect(admission.affiliateAttribution).toEqual({
    affiliateCodeId: `affiliate-${affiliateCode}`,
    affiliateUserId: "affiliate-owner",
    affiliateCode,
    markupPercent: 0.2,
  });
  expect(admission.reservation).toMatchObject({
    affiliateAttribution: admission.affiliateAttribution,
    affiliatePayoutSourceId: `ai_billing:affiliate:request-${modelSequence}`,
  });
  await admission.reservation?.reconcile(0.02);
  expect(deferredSettle).toHaveBeenCalledWith(0.02);
});

test("affiliate reservation infrastructure failure blocks the next cached dispatch", async () => {
  const model = nextModel();
  const affiliateCode = `PARTNER-${modelSequence}`;
  const coldBackground: Promise<unknown>[] = [];
  await admitOrganizationInference(admissionParams(model, coldBackground, { affiliateCode })).then(
    () => null,
    () => null,
  );
  await Promise.all(coldBackground);

  reservationError = new Error("reservation database unavailable");
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(
    admissionParams(model, background, { affiliateCode }),
  );
  expect(admission.mode).toBe("deferred_reservation");
  await expect(background[0]).rejects.toBe(reservationError);
  expect(orgRefused).toBe(true);

  const retryBackground: Promise<unknown>[] = [];
  await expect(
    admitOrganizationInference(admissionParams(model, retryBackground, { affiliateCode })),
  ).rejects.toMatchObject({ name: "InferenceAdmissionUnavailableError" });
  expect(retryBackground).toHaveLength(1);
});

test("non-Worker affiliate admission keeps synchronous reservation compatibility", async () => {
  const model = nextModel();
  const admission = await admitOrganizationInference({
    ...admissionParams(model, [], { affiliateCode: "PARTNER-NODE" }),
    executionCtx: undefined,
  });

  expect(admission.mode).toBe("synchronous_reservation");
  expect(reserveCredits).toHaveBeenCalledTimes(1);
  expect(pairReads).toBe(0);
  expect(affiliateReads).toBe(0);
});
