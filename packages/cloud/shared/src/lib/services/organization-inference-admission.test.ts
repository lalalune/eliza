/**
 * Verifies warm organization admission never joins a database reservation.
 *
 * The cache/ledger seams are deterministic tripwires so the test proves the
 * response-facing promise ends after the balance hint read.
 */

import { expect, mock, test } from "bun:test";

const reserveCredits = mock(async () => {
  throw new Error("synchronous reservation must not run");
});
const writePendingInferenceCharge = mock(async () => true);
const optimisticSettle = mock(async () => null);
const deferredSettle = mock(async () => null);

mock.module("../pricing", () => ({
  normalizeModelName: (model: string) => model,
  calculateCost: async () => ({ totalCost: 0.02 }),
}));
mock.module("./ai-billing", () => ({ reserveCredits }));
mock.module("../utils/credit-reservation", () => ({
  createCreditReservationSettler: () => optimisticSettle,
}));
mock.module("./inference-billing-fast-path", () => ({
  createOptimisticDebitSettler: () => optimisticSettle,
  getGateBalanceUsd: async () => 50,
  isOptimisticBackstopAvailable: () => true,
  isOptimisticBillingEnabled: () => true,
  isOptimisticEligible: () => true,
  resolveSafeBalanceThresholdUsd: () => 5,
  writePendingInferenceCharge,
}));
mock.module("./inference-billing-ledger", () => ({
  admitInferenceChargeViaLedger: async () => ({ admitted: true }),
  createLedgerDebitSettler: () => optimisticSettle,
  resolveInferenceBillingLedger: () => "kv",
}));
mock.module("./inference-billing-deferred", () => ({
  createDeferredAdmissionSettler: () => deferredSettle,
  isDeferredAdmissionEnabled: () => true,
  isOrgAdmissionRefused: () => false,
}));

const { admitOrganizationInference } = await import(
  "./organization-inference-admission"
);

test("warm deferred admission schedules the ledger and skips reserveCredits", async () => {
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference({
    context: {
      organizationId: "org-1",
      userId: "user-1",
      model: "cerebras:gpt-oss-120b",
      provider: "cerebras",
      billingSource: "bitrouter",
      requestId: "request-1",
    },
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    executionCtx: {
      waitUntil: (promise) => background.push(promise),
    },
  });

  expect(admission.mode).toBe("deferred_kv_ledger");
  expect(background).toHaveLength(1);
  await background[0];
  expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
  expect(reserveCredits).not.toHaveBeenCalled();
  await admission.settle(0.01);
  expect(deferredSettle).toHaveBeenCalledWith(0.01);
});
