/**
 * Serialized organization-balance leases for Worker inference admission.
 *
 * Cloudflare KV is eventually consistent and cannot safely decrement a cached
 * balance under concurrency. The Worker therefore leases estimated spend from
 * a per-organization Durable Object before provider dispatch, while Postgres
 * reservation and settlement remain asynchronous.
 */

import { sql } from "drizzle-orm";
import { sqlRows } from "../../db/execute-helpers";
import { writeTransaction } from "../../db/helpers";
import type {
  RuntimeDurableObjectNamespace,
  RuntimeDurableObjectStub,
} from "../../types/cloud-worker-env";
import { getCloudBinding } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import type { CreditReconciliationResult } from "./credits";

const GATE_BINDING = "INFERENCE_ADMISSION_GATES";
const GATE_ORIGIN = "https://inference-admission.internal";
const HYDRATION_GATE_TIMEOUT_MS = 5_000;

interface LeaseResponse {
  admitted: boolean;
  availableUsd: number;
  requiredUsd: number;
}

interface SettleResponse {
  settled: boolean;
}

interface HydrateResponse {
  hydrated: boolean;
}

export interface InferenceAdmissionLease {
  organizationId: string;
  requestId: string;
  estimatedCostUsd: number;
  gate: RuntimeDurableObjectStub;
}

export class InferenceAdmissionGateUnavailableError extends Error {
  constructor(message = "Inference admission gate is unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InferenceAdmissionGateUnavailableError";
  }
}

export class InferenceAdmissionLeaseRejectedError extends Error {
  constructor(
    readonly requiredUsd: number,
    readonly availableUsd: number,
  ) {
    super(
      `Inference admission lease rejected. Required: $${requiredUsd.toFixed(4)}, Available: $${availableUsd.toFixed(4)}`,
    );
    this.name = "InferenceAdmissionLeaseRejectedError";
  }
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new InferenceAdmissionGateUnavailableError(
      `Invalid ${field} supplied to inference admission gate`,
    );
  }
  return value;
}

function gateStub(organizationId: string): RuntimeDurableObjectStub {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>(GATE_BINDING);
  if (!namespace) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission Durable Object binding is missing",
    );
  }
  return namespace.getByName(organizationId);
}

async function gateFetch(
  organizationId: string,
  path: string,
  body: Record<string, unknown>,
  stub = gateStub(organizationId),
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await stub.fetch(
      new Request(`${GATE_ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  } catch (error) {
    if (error instanceof InferenceAdmissionGateUnavailableError) throw error;
    // error-policy:J2 preserve the failed binding/transport operation as cause.
    throw new InferenceAdmissionGateUnavailableError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

async function parseLeaseResponse(response: Response): Promise<LeaseResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>).admitted !== "boolean" ||
      !Number.isFinite((value as Record<string, unknown>).availableUsd) ||
      !Number.isFinite((value as Record<string, unknown>).requiredUsd)
    ) {
      throw new TypeError("response does not match the lease schema");
    }
    return value as LeaseResponse;
  } catch (error) {
    // error-policy:J3 a malformed Durable Object response is an explicit
    // unavailable decision, never an admission fallback.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function parseSettleResponse(response: Response): Promise<SettleResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>).settled !== true
    ) {
      throw new TypeError("response does not match the settlement schema");
    }
    return value as SettleResponse;
  } catch (error) {
    // error-policy:J3 malformed responses never become successful settlement.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid settlement JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function parseHydrateResponse(response: Response): Promise<HydrateResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>).hydrated !== true
    ) {
      throw new TypeError("response does not match the hydration schema");
    }
    return value as HydrateResponse;
  } catch (error) {
    // error-policy:J3 malformed responses never become successful hydration.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid hydration JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function readGateErrorCode(response: Response): Promise<string | undefined> {
  try {
    const value = await response.json();
    if (typeof value !== "object" || value === null) return undefined;
    const code = (value as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    // error-policy:J3 a malformed error payload remains an unavailable
    // decision; callers never treat it as admission.
    return undefined;
  }
}

const gateHydrations = new Map<string, Promise<void>>();

function hydrateInferenceAdmissionGate(
  organizationId: string,
  stub: RuntimeDurableObjectStub,
): Promise<void> {
  const existing = gateHydrations.get(organizationId);
  if (existing) return existing;
  const hydration = writeTransaction(async (tx) => {
    const rows = await sqlRows<{
      credit_balance: string | number | null;
      balance_revision: string | number | null;
    }>(
      tx,
      sql`
        SELECT credit_balance, balance_revision
        FROM organizations
        WHERE id = ${organizationId}
        FOR UPDATE
      `,
    );
    const row = rows[0];
    const balanceUsd = row ? Number(row.credit_balance) : 0;
    const balanceRevision = row ? String(row.balance_revision) : "0";
    if (!Number.isFinite(balanceUsd) || balanceUsd < 0 || !/^(0|[1-9]\d*)$/.test(balanceRevision)) {
      throw new InferenceAdmissionGateUnavailableError(
        "Authoritative inference balance snapshot is invalid",
      );
    }
    const response = await gateFetch(
      organizationId,
      "/hydrate",
      { balanceUsd, balanceRevision },
      stub,
      AbortSignal.timeout(HYDRATION_GATE_TIMEOUT_MS),
    );
    if (!response.ok) {
      throw new InferenceAdmissionGateUnavailableError(
        `Inference admission gate hydration failed with status ${response.status}`,
      );
    }
    await parseHydrateResponse(response);
  }).finally(() => {
    gateHydrations.delete(organizationId);
  });
  gateHydrations.set(organizationId, hydration);
  return hydration;
}

function scheduleGateHydration(
  organizationId: string,
  stub: RuntimeDurableObjectStub,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): void {
  const observed = hydrateInferenceAdmissionGate(organizationId, stub).catch((error) => {
    // error-policy:J7 cold-gate hydration is retried by the next 503 request;
    // log the failure without turning the already-returned response into 500.
    logger.warn("[InferenceAdmissionGate] hydration failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  executionCtx.waitUntil(observed);
}

/**
 * Atomically lease an estimated charge from the cached organization balance.
 * Duplicate request IDs are idempotent only when the amount is identical.
 */
export async function acquireInferenceAdmissionLease(params: {
  organizationId: string;
  requestId: string;
  balanceUsd: number;
  balanceRevision: string;
  estimatedCostUsd: number;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}): Promise<InferenceAdmissionLease> {
  const balanceUsd = finiteNonNegative(params.balanceUsd, "balanceUsd");
  const estimatedCostUsd = finiteNonNegative(params.estimatedCostUsd, "estimatedCostUsd");
  if (
    !params.organizationId ||
    !params.requestId ||
    !/^(0|[1-9]\d*)$/.test(params.balanceRevision) ||
    estimatedCostUsd === 0
  ) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission lease identity and positive cost are required",
    );
  }

  const stub = gateStub(params.organizationId);
  const response = await gateFetch(
    params.organizationId,
    "/lease",
    {
      requestId: params.requestId,
      balanceUsd,
      balanceRevision: params.balanceRevision,
      estimatedCostUsd,
    },
    stub,
  );
  if (response.status === 503) {
    const code = await readGateErrorCode(response);
    if (code === "inference_admission_gate_uninitialized" && params.executionCtx) {
      scheduleGateHydration(params.organizationId, stub, params.executionCtx);
    }
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate lease failed with status ${response.status}`,
    );
  }
  const payload = await parseLeaseResponse(response);
  if (response.status === 402) {
    throw new InferenceAdmissionLeaseRejectedError(payload.requiredUsd, payload.availableUsd);
  }
  if (!response.ok || !payload?.admitted) {
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate lease failed with status ${response.status}`,
    );
  }
  return {
    organizationId: params.organizationId,
    requestId: params.requestId,
    estimatedCostUsd,
    gate: stub,
  };
}

/** Convert reconciliation into the amount that was actually collected. */
export function collectedInferenceCost(
  lease: InferenceAdmissionLease,
  actualCostUsd: number,
  reconciliation: CreditReconciliationResult | null,
): number {
  const actual = finiteNonNegative(actualCostUsd, "actualCostUsd");
  if (!reconciliation) {
    return Math.max(actual, lease.estimatedCostUsd);
  }
  if (reconciliation.adjustmentType === "uncollected_overage") {
    return Math.max(actual, lease.estimatedCostUsd);
  }
  return actual;
}

/**
 * Release a lease after authoritative settlement. The gate adjusts its local
 * balance by estimated minus collected cost, preserving burst safety until its
 * idle reset consumes a fresh shared-cache balance.
 */
export async function settleInferenceAdmissionLease(
  lease: InferenceAdmissionLease,
  collectedCostUsd: number,
): Promise<void> {
  const collectedUsd = finiteNonNegative(collectedCostUsd, "collectedCostUsd");
  const response = await gateFetch(
    lease.organizationId,
    "/settle",
    {
      requestId: lease.requestId,
      collectedUsd,
    },
    lease.gate,
  );
  if (!response.ok) {
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate settlement failed with status ${response.status}`,
    );
  }
  await parseSettleResponse(response);
}
