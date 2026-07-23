/**
 * Per-organization serialized balance leasing for inference requests.
 *
 * The object never queries Postgres. It bounds concurrent provider dispatches
 * to the latest cached balance. Capacity can only increase from a cache
 * snapshot observed after the last accounting event, so stale KV values cannot
 * resurrect already-consumed spend.
 */

import type { AppEnv } from "@/types/cloud-worker-env";

interface ActiveLease {
  estimatedCostUsd: number;
  createdAt: number;
  expiredAt?: number;
}

interface GateLedger {
  balanceRevision: string;
  balanceCeilingUsd: number;
  availableUsd: number;
  leases: Record<string, ActiveLease>;
  settledRequestIds: string[];
}

interface LeaseRequest {
  requestId: string;
  balanceUsd: number;
  balanceRevision: string;
  estimatedCostUsd: number;
}

interface HydrateRequest {
  balanceUsd: number;
  balanceRevision: string;
}

interface SettleRequest {
  requestId: string;
  collectedUsd: number;
}

const LEDGER_KEY = "ledger";
const MAX_LEASE_AGE_MS = 20 * 60_000;
const MAX_ACTIVE_LEASES = 2_048;
const MAX_SETTLED_REQUEST_IDS = 2_048;

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function balanceRevision(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

function jsonError(message: string, status: 400 | 409 | 503): Response {
  return Response.json({ success: false, error: message }, { status });
}

function cloneLedger(ledger: GateLedger): GateLedger {
  return {
    balanceRevision: ledger.balanceRevision,
    balanceCeilingUsd: ledger.balanceCeilingUsd,
    availableUsd: ledger.availableUsd,
    leases: Object.fromEntries(
      Object.entries(ledger.leases).map(([requestId, lease]) => [
        requestId,
        { ...lease },
      ]),
    ),
    settledRequestIds: [...ledger.settledRequestIds],
  };
}

function rememberSettledRequest(ledger: GateLedger, requestId: string): void {
  ledger.settledRequestIds.push(requestId);
  if (ledger.settledRequestIds.length > MAX_SETTLED_REQUEST_IDS) {
    ledger.settledRequestIds.splice(
      0,
      ledger.settledRequestIds.length - MAX_SETTLED_REQUEST_IDS,
    );
  }
}

function reapExpiredLeases(ledger: GateLedger, now: number): boolean {
  let reaped = false;
  for (const lease of Object.values(ledger.leases)) {
    if (
      lease.expiredAt !== undefined ||
      now - lease.createdAt < MAX_LEASE_AGE_MS
    ) {
      continue;
    }
    // An expired lease remains a conservative monetary hold. A late
    // authoritative settlement can still reconcile its estimate-vs-actual
    // delta; silently releasing it would resurrect uncollected spend.
    lease.expiredAt = now;
    reaped = true;
  }
  return reaped;
}

export class InferenceAdmissionGate {
  private readonly state: DurableObjectState;
  private ledger: GateLedger | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, _env: AppEnv["Bindings"]) {
    this.state = state;
  }

  private async load(): Promise<GateLedger | undefined> {
    this.ledger ??= await this.state.storage.get<GateLedger>(LEDGER_KEY);
    return this.ledger;
  }

  private async save(ledger: GateLedger): Promise<void> {
    const snapshot = cloneLedger(ledger);
    await this.state.storage.put(LEDGER_KEY, snapshot);
    this.ledger = snapshot;
    const activeLeases = Object.values(snapshot.leases).filter(
      (lease) => lease.expiredAt === undefined,
    );
    if (activeLeases.length > 0) {
      const nextAlarm = Math.min(
        ...activeLeases.map((lease) => lease.createdAt + MAX_LEASE_AGE_MS),
      );
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1_000, nextAlarm),
      );
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async lease(request: LeaseRequest): Promise<Response> {
    if (
      !validId(request.requestId) ||
      !nonNegativeFinite(request.balanceUsd) ||
      balanceRevision(request.balanceRevision) === null ||
      !nonNegativeFinite(request.estimatedCostUsd) ||
      request.estimatedCostUsd === 0
    ) {
      return jsonError("Invalid inference admission lease", 400);
    }

    const now = Date.now();
    const existing = await this.load();
    if (!existing) {
      return Response.json(
        {
          success: false,
          code: "inference_admission_gate_uninitialized",
          error: "Inference admission gate is warming",
        },
        { status: 503 },
      );
    }
    const ledger = cloneLedger(existing);
    reapExpiredLeases(ledger, now);

    const incomingRevision = balanceRevision(request.balanceRevision);
    const currentRevision = balanceRevision(ledger.balanceRevision);
    if (incomingRevision === null || currentRevision === null) {
      return jsonError("Inference balance revision is invalid", 503);
    }
    if (
      Object.values(ledger.leases).every(
        (lease) => lease.expiredAt !== undefined,
      ) &&
      incomingRevision > currentRevision
    ) {
      ledger.balanceRevision = request.balanceRevision;
      ledger.balanceCeilingUsd = request.balanceUsd;
      const outstandingEstimateUsd = Object.values(ledger.leases).reduce(
        (total, lease) => total + lease.estimatedCostUsd,
        0,
      );
      ledger.availableUsd = Math.max(
        0,
        request.balanceUsd - outstandingEstimateUsd,
      );
    } else {
      ledger.balanceCeilingUsd = Math.min(
        ledger.balanceCeilingUsd,
        request.balanceUsd,
      );
    }
    const activeEstimateUsd = Object.values(ledger.leases).reduce(
      (total, lease) => total + lease.estimatedCostUsd,
      0,
    );
    // A lower shared-cache hint can only reduce capacity. Higher hints are
    // accepted only from a strictly newer database balance revision.
    ledger.availableUsd = Math.min(
      ledger.availableUsd,
      Math.max(0, ledger.balanceCeilingUsd - activeEstimateUsd),
    );

    const prior = ledger.leases[request.requestId];
    if (prior) {
      if (prior.estimatedCostUsd !== request.estimatedCostUsd) {
        await this.save(ledger);
        return jsonError(
          "Request ID already holds a different inference admission lease",
          409,
        );
      }
      await this.save(ledger);
      return Response.json({
        admitted: true,
        availableUsd: ledger.availableUsd,
        requiredUsd: request.estimatedCostUsd,
      });
    }
    if (ledger.settledRequestIds.includes(request.requestId)) {
      await this.save(ledger);
      return jsonError("Request ID was already settled", 409);
    }
    const activeLeaseCount = Object.values(ledger.leases).filter(
      (lease) => lease.expiredAt === undefined,
    ).length;
    if (
      activeLeaseCount >= MAX_ACTIVE_LEASES ||
      Object.keys(ledger.leases).length >= MAX_ACTIVE_LEASES * 2
    ) {
      await this.save(ledger);
      return jsonError("Inference admission gate capacity is exhausted", 503);
    }

    if (ledger.availableUsd < request.estimatedCostUsd) {
      await this.save(ledger);
      return Response.json(
        {
          admitted: false,
          availableUsd: ledger.availableUsd,
          requiredUsd: request.estimatedCostUsd,
        },
        { status: 402 },
      );
    }

    ledger.availableUsd -= request.estimatedCostUsd;
    ledger.leases[request.requestId] = {
      estimatedCostUsd: request.estimatedCostUsd,
      createdAt: now,
    };
    await this.save(ledger);
    return Response.json({
      admitted: true,
      availableUsd: ledger.availableUsd,
      requiredUsd: request.estimatedCostUsd,
    });
  }

  private async hydrate(request: HydrateRequest): Promise<Response> {
    if (
      !nonNegativeFinite(request.balanceUsd) ||
      balanceRevision(request.balanceRevision) === null
    ) {
      return jsonError("Invalid inference admission hydration", 400);
    }
    const existing = await this.load();
    if (!existing) {
      await this.save({
        balanceRevision: request.balanceRevision,
        balanceCeilingUsd: request.balanceUsd,
        availableUsd: request.balanceUsd,
        leases: {},
        settledRequestIds: [],
      });
      return Response.json({ hydrated: true, initialized: true });
    }
    return Response.json({ hydrated: true, initialized: false });
  }

  private async settle(request: SettleRequest): Promise<Response> {
    if (
      !validId(request.requestId) ||
      !nonNegativeFinite(request.collectedUsd)
    ) {
      return jsonError("Invalid inference admission settlement", 400);
    }
    const existing = await this.load();
    if (!existing) {
      return jsonError("Inference admission ledger is unavailable", 503);
    }
    if (existing.settledRequestIds.includes(request.requestId)) {
      return Response.json({ settled: true, duplicate: true });
    }
    const ledger = cloneLedger(existing);
    const lease = ledger.leases[request.requestId];
    if (!lease) {
      return jsonError("Inference admission lease was not found", 409);
    }

    delete ledger.leases[request.requestId];
    const remainingEstimateUsd = Object.values(ledger.leases).reduce(
      (total, activeLease) => total + activeLease.estimatedCostUsd,
      0,
    );
    ledger.availableUsd = Math.min(
      Math.max(
        0,
        ledger.availableUsd + lease.estimatedCostUsd - request.collectedUsd,
      ),
      Math.max(0, ledger.balanceCeilingUsd - remainingEstimateUsd),
    );
    rememberSettledRequest(ledger, request.requestId);
    await this.save(ledger);
    return Response.json({ settled: true, duplicate: false });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    let body: LeaseRequest | SettleRequest;
    try {
      body = (await request.json()) as LeaseRequest | SettleRequest;
    } catch {
      // error-policy:J3 malformed request bodies are rejected explicitly.
      return jsonError("Invalid JSON body", 400);
    }
    if (!body) return jsonError("Invalid JSON body", 400);
    const path = new URL(request.url).pathname;
    if (path === "/lease") {
      return await this.serialize(() => this.lease(body as LeaseRequest));
    }
    if (path === "/hydrate") {
      return await this.serialize(() => this.hydrate(body as HydrateRequest));
    }
    if (path === "/settle") {
      return await this.serialize(() => this.settle(body as SettleRequest));
    }
    return new Response("Not found", { status: 404 });
  }

  private async handleAlarm(): Promise<void> {
    const existing = await this.load();
    if (!existing) return;
    const ledger = cloneLedger(existing);
    reapExpiredLeases(ledger, Date.now());
    await this.save(ledger);
  }

  async alarm(): Promise<void> {
    await this.serialize(() => this.handleAlarm());
  }
}
