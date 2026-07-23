/**
 * Exercises the production cache-only balance gate with an in-memory Durable
 * Object state, including concurrent admission and typed fail-closed clients.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import {
  acquireInferenceAdmissionLease,
  InferenceAdmissionGateUnavailableError,
  InferenceAdmissionLeaseRejectedError,
  settleInferenceAdmissionLease,
} from "@/lib/services/inference-admission-gate";
import { InferenceAdmissionGate } from "../src/inference-admission-gate";

class TestStorage {
  private readonly values = new Map<string, unknown>();
  alarm: number | undefined;
  failNextPut = false;

  async get<T>(key: string): Promise<T | undefined> {
    await Promise.resolve();
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("injected storage failure");
    }
    this.values.set(key, structuredClone(value));
  }

  read<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }
}

function createGate(storage = new TestStorage()): InferenceAdmissionGate {
  const state = {
    storage,
  } as unknown as DurableObjectState;
  return new InferenceAdmissionGate(state, {} as never);
}

function post(
  gate: InferenceAdmissionGate,
  path: "/hydrate" | "/lease" | "/settle",
  body: Record<string, unknown>,
): Promise<Response> {
  return gate.fetch(
    new Request(`https://gate.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function hydrateGate(
  gate: InferenceAdmissionGate,
  balanceUsd: number,
  balanceRevision = "1",
): Promise<void> {
  expect(
    (
      await post(gate, "/hydrate", {
        balanceUsd,
        balanceRevision,
      })
    ).status,
  ).toBe(200);
}

function gateBindings(gate: InferenceAdmissionGate) {
  return {
    INFERENCE_ADMISSION_GATES: {
      getByName: (_name: string) => ({
        fetch: (request: RequestInfo | URL, init?: RequestInit) =>
          gate.fetch(new Request(request, init)),
      }),
    },
  };
}

describe("InferenceAdmissionGate", () => {
  test("serializes concurrent leases so cached balance cannot be overspent", async () => {
    const gate = createGate();
    await hydrateGate(gate, 5);
    const responses = await Promise.all([
      post(gate, "/lease", {
        requestId: "request-a",
        balanceUsd: 5,
        balanceAt: Date.now(),
        balanceRevision: "1",
        estimatedCostUsd: 3,
      }),
      post(gate, "/lease", {
        requestId: "request-b",
        balanceUsd: 5,
        balanceAt: Date.now(),
        balanceRevision: "1",
        estimatedCostUsd: 3,
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 402,
    ]);
  });

  test("settles collected cost and never restores capacity from a stale high hint", async () => {
    const gate = createGate();
    await hydrateGate(gate, 5);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-a",
          balanceUsd: 5,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/settle", {
          requestId: "request-a",
          collectedUsd: 2,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-b",
          balanceUsd: 50,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-c",
          balanceUsd: 50,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 1,
        })
      ).status,
    ).toBe(402);
  });

  test("repeat hydration cannot double-count an active authoritative hold", async () => {
    const gate = createGate();
    await hydrateGate(gate, 100, "1");
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-a",
          balanceUsd: 100,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 10,
        })
      ).status,
    ).toBe(200);
    await hydrateGate(gate, 90, "2");
    expect(
      (
        await post(gate, "/settle", {
          requestId: "request-a",
          collectedUsd: 10,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-b",
          balanceUsd: 90,
          balanceAt: Date.now(),
          balanceRevision: "2",
          estimatedCostUsd: 90,
        })
      ).status,
    ).toBe(200);
  });

  test("treats an identical lease retry as idempotent", async () => {
    const gate = createGate();
    await hydrateGate(gate, 5);
    const body = {
      requestId: "request-a",
      balanceUsd: 5,
      balanceAt: Date.now(),
      balanceRevision: "1",
      estimatedCostUsd: 3,
    };

    expect((await post(gate, "/lease", body)).status).toBe(200);
    expect((await post(gate, "/lease", body)).status).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          ...body,
          estimatedCostUsd: 4,
        })
      ).status,
    ).toBe(409);
  });

  test("client maps rejection and missing bindings to typed failures", async () => {
    const gate = createGate();
    await hydrateGate(gate, 2);
    await runWithCloudBindingsAsync(gateBindings(gate), async () => {
      const lease = await acquireInferenceAdmissionLease({
        organizationId: "org-a",
        requestId: "request-a",
        balanceUsd: 2,
        balanceRevision: "1",
        estimatedCostUsd: 2,
      });
      await expect(
        acquireInferenceAdmissionLease({
          organizationId: "org-a",
          requestId: "request-b",
          balanceUsd: 2,
          balanceRevision: "1",
          estimatedCostUsd: 1,
        }),
      ).rejects.toBeInstanceOf(InferenceAdmissionLeaseRejectedError);
      await settleInferenceAdmissionLease(lease, 2);
    });

    await expect(
      acquireInferenceAdmissionLease({
        organizationId: "org-a",
        requestId: "request-c",
        balanceUsd: 2,
        balanceRevision: "1",
        estimatedCostUsd: 1,
      }),
    ).rejects.toBeInstanceOf(InferenceAdmissionGateUnavailableError);
  });

  test("does not publish an unpersisted lease after a storage failure", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 5);
    storage.failNextPut = true;
    const body = {
      requestId: "request-a",
      balanceUsd: 5,
      balanceAt: Date.now(),
      balanceRevision: "1",
      estimatedCostUsd: 3,
    };

    await expect(post(gate, "/lease", body)).rejects.toThrow(
      "injected storage failure",
    );
    expect(
      storage.read<{ leases: Record<string, unknown> }>("ledger")?.leases,
    ).toEqual({});
    expect((await post(gate, "/lease", body)).status).toBe(200);
    expect(
      storage.read<{ leases: Record<string, unknown> }>("ledger"),
    ).toHaveProperty("leases.request-a");
  });

  test("persists a lower rejected hint across Durable Object eviction", async () => {
    const storage = new TestStorage();
    const first = createGate(storage);
    await hydrateGate(first, 5);
    expect(
      (
        await post(first, "/lease", {
          requestId: "request-a",
          balanceUsd: 5,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(first, "/lease", {
          requestId: "request-b",
          balanceUsd: 1,
          balanceAt: Date.now(),
          balanceRevision: "2",
          estimatedCostUsd: 1,
        })
      ).status,
    ).toBe(402);

    const evicted = createGate(storage);
    expect(
      (
        await post(evicted, "/settle", {
          requestId: "request-a",
          collectedUsd: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(evicted, "/lease", {
          requestId: "request-c",
          balanceUsd: 5,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 2,
        })
      ).status,
    ).toBe(402);
  });

  test("never restores spent capacity from a stale revision after idle time", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 10);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceAt: 1_000,
            balanceRevision: "1",
            estimatedCostUsd: 6,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/settle", {
            requestId: "request-a",
            collectedUsd: 6,
          })
        ).status,
      ).toBe(200);

      clock.mockReturnValue(1_000_000);
      await gate.alarm();
      const evicted = createGate(storage);
      expect(
        (
          await post(evicted, "/lease", {
            requestId: "request-b",
            balanceUsd: 10,
            balanceAt: 900_000,
            balanceRevision: "1",
            estimatedCostUsd: 6,
          })
        ).status,
      ).toBe(402);
    } finally {
      clock.mockRestore();
    }
  });

  test("keeps an expired hold and applies a late over-estimate settlement", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const gate = createGate();
      await hydrateGate(gate, 10);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceAt: 1_000,
            balanceRevision: "1",
            estimatedCostUsd: 2,
          })
        ).status,
      ).toBe(200);
      clock.mockReturnValue(1_300_000);
      await gate.alarm();
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-b",
            balanceUsd: 10,
            balanceAt: 1_299_000,
            balanceRevision: "1",
            estimatedCostUsd: 7,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/settle", {
            requestId: "request-a",
            collectedUsd: 8,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-c",
            balanceUsd: 10,
            balanceAt: 1_299_000,
            balanceRevision: "1",
            estimatedCostUsd: 1,
          })
        ).status,
      ).toBe(402);
    } finally {
      clock.mockRestore();
    }
  });

  test("refuses to initialize a new gate from any lease hint", async () => {
    expect(
      (
        await post(createGate(), "/lease", {
          requestId: "request-a",
          balanceUsd: 10,
          balanceRevision: "1",
          estimatedCostUsd: 1,
        })
      ).status,
    ).toBe(503);
  });
});
