/** Exercises health route can-respond HTTP behavior with deterministic server test doubles. */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { computeCanRespond, summarizeServiceHealth } from "./health-routes";

/**
 * computeCanRespond is the single source of truth for "first-turn capability
 * online" shared by GET /api/status AND the WS `status` broadcast. Locking the
 * contract here keeps the two readiness signals from drifting (the drift that
 * stuck the chat composer on "waking up").
 */
function makeRuntime(opts: { hasTextHandler: boolean }): AgentRuntime {
  return {
    getModel: (key: string) =>
      opts.hasTextHandler && key === ModelType.TEXT_LARGE
        ? () => undefined
        : undefined,
  } as unknown as AgentRuntime;
}

describe("computeCanRespond", () => {
  it("is false when there is no runtime", () => {
    expect(computeCanRespond(null, "running")).toBe(false);
  });

  it("is false when the agent is not running, even with a text handler", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: true }), "starting"),
    ).toBe(false);
  });

  it("is false when running but no TEXT generation handler is registered", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: false }), "running"),
    ).toBe(false);
  });

  it("is true once running with a registered TEXT generation handler", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: true }), "running"),
    ).toBe(true);
  });
});

describe("summarizeServiceHealth", () => {
  it("separates registered, in-flight, and failed services for boot probes", () => {
    const runtime = {
      getServiceHealth: () => ({
        database: { status: "registered", instances: 1, hasPromise: true },
        scheduler: { status: "registering", instances: 0, hasPromise: true },
        inbox_migration: {
          status: "failed",
          instances: 0,
          hasPromise: false,
        },
        optional_unknown: {
          status: "unknown",
          instances: 0,
          hasPromise: false,
        },
      }),
    } as unknown as AgentRuntime;

    expect(summarizeServiceHealth(runtime)).toEqual({
      status: "failed",
      registered: 1,
      pending: 1,
      failed: 1,
      pendingServices: ["scheduler"],
      failures: ["inbox_migration"],
    });
  });

  it("returns an explicit zero summary before the runtime exists", () => {
    expect(summarizeServiceHealth(null)).toEqual({
      status: "unavailable",
      registered: null,
      pending: null,
      failed: null,
      pendingServices: null,
      failures: null,
    });
  });
});
