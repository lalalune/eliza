/**
 * Covers adoption of persisted app setup into LifeOps first-run state against
 * the real cache contract, including concurrency and active-flow preservation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcilePersistedAppFirstRunCompletion } from "../src/lifeops/first-run/app-completion-reconciliation.ts";
import { createFirstRunStateStore } from "../src/lifeops/first-run/state.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

const previousCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

beforeEach(() => {
  delete process.env.ELIZA_CLOUD_PROVISIONED;
});

afterEach(() => {
  if (previousCloudProvisioned === undefined) {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  } else {
    process.env.ELIZA_CLOUD_PROVISIONED = previousCloudProvisioned;
  }
});

describe("LifeOps app-completion handoff", () => {
  it("adopts pending state exactly once across repeated concurrent calls", async () => {
    const runtime = createMinimalRuntimeStub();
    const records = await Promise.all(
      Array.from({ length: 32 }, () =>
        createFirstRunStateStore(runtime).adoptAppCompletion(),
      ),
    );

    expect(records.every((record) => record.status === "complete")).toBe(true);
    const persisted = await createFirstRunStateStore(runtime).read();
    expect(persisted).toMatchObject({
      status: "complete",
      path: "app_handoff",
      completionCount: 1,
      partialAnswers: {},
    });
    expect(persisted.startedAt).toBe(persisted.completedAt);

    const repeated =
      await createFirstRunStateStore(runtime).adoptAppCompletion();
    expect(repeated).toEqual(persisted);
  });

  it.each(["customize", "replay"] as const)(
    "preserves an active %s flow and its answers",
    async (path) => {
      const runtime = createMinimalRuntimeStub();
      const store = createFirstRunStateStore(runtime);
      await store.begin(path);
      await store.recordAnswer("wakeTime", "06:30");
      const before = await store.read();

      const after = await store.adoptAppCompletion();

      expect(after).toEqual(before);
      expect(after.status).toBe("in_progress");
      expect(after.path).toBe(path);
      expect(after.partialAnswers).toEqual({ wakeTime: "06:30" });
    },
  );

  it("preserves an already-complete interactive run", async () => {
    const runtime = createMinimalRuntimeStub();
    const store = createFirstRunStateStore(runtime);
    await store.begin("defaults");
    const completed = await store.complete();

    const adopted = await Promise.all(
      Array.from({ length: 8 }, () =>
        createFirstRunStateStore(runtime).adoptAppCompletion(),
      ),
    );

    expect(adopted.every((record) => record.completionCount === 1)).toBe(true);
    expect(await store.read()).toEqual(completed);
  });

  it("reconciles the persisted app marker during init without inventing a flow", async () => {
    const runtime = createMinimalRuntimeStub();
    const record = await reconcilePersistedAppFirstRunCompletion(runtime, {
      meta: { firstRunComplete: true },
    });

    expect(record).toMatchObject({
      status: "complete",
      path: "app_handoff",
      completionCount: 1,
    });
  });

  it("recognizes a provisioned Eliza Cloud routing config as persisted completion", async () => {
    const runtime = createMinimalRuntimeStub();
    const record = await reconcilePersistedAppFirstRunCompletion(runtime, {
      serviceRouting: {
        llmText: {
          transport: "cloud-proxy",
          backend: "elizacloud",
          smallModel: "openai/gpt-oss-120b",
          largeModel: "zai-glm-4.7",
        },
      },
    });

    expect(record).toMatchObject({
      status: "complete",
      path: "app_handoff",
      completionCount: 1,
    });
  });

  it("recognizes managed Cloud runtime completion without fabricated routing", async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const runtime = createMinimalRuntimeStub();

    const record = await reconcilePersistedAppFirstRunCompletion(runtime, {});

    expect(record).toMatchObject({
      status: "complete",
      path: "app_handoff",
      completionCount: 1,
    });
  });

  it("leaves LifeOps pending when app setup is not persisted", async () => {
    const runtime = createMinimalRuntimeStub();
    const record = await reconcilePersistedAppFirstRunCompletion(runtime, {});

    expect(record).toEqual({
      status: "pending",
      partialAnswers: {},
      completionCount: 0,
    });
  });

  it("surfaces cache failures to the plugin-init boundary", async () => {
    const runtime = createMinimalRuntimeStub({
      getCache: async () => {
        throw new Error("cache unavailable");
      },
    });

    await expect(
      reconcilePersistedAppFirstRunCompletion(runtime, {
        meta: { firstRunComplete: true },
      }),
    ).rejects.toThrow("cache unavailable");
  });
});
