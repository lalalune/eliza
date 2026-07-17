/**
 * Compatibility registry for callers that track inference AbortControllers
 * through app-core. Runtime inference cancellation belongs to core's
 * TurnControllerRegistry; this WeakMap preserves the published app-core API
 * until its next major release.
 */

import type { IAgentRuntime } from "@elizaos/core";

const trackers = new WeakMap<IAgentRuntime, Set<AbortController>>();

/**
 * Register a fresh `AbortController` with the runtime's in-flight set.
 * Returns a disposer that removes the controller from the set; callers
 * MUST invoke it in the finally block so completed calls are GC'd.
 *
 * @deprecated New inference paths register with the runtime-owned turn
 * controller machinery in `@elizaos/core`. This compatibility registry will
 * be removed in the next major release (#16470).
 */
export function trackInflight(
  runtime: IAgentRuntime,
  controller: AbortController,
): () => void {
  let set = trackers.get(runtime);
  if (!set) {
    set = new Set<AbortController>();
    trackers.set(runtime, set);
  }
  set.add(controller);
  return () => {
    set.delete(controller);
  };
}

/**
 * Abort every in-flight inference controller for the runtime. Called by
 * the UI on `APP_PAUSE_EVENT` and by other shutdown paths (account
 * switch, hard logout, runtime teardown).
 *
 * Returns `{aborted}` so the caller can emit a structured log line.
 * Idempotent — calling on a runtime with no in-flight work returns
 * `{aborted: 0}` and does nothing.
 *
 * @deprecated Use `@elizaos/core`'s `abortInflightInference(runtime, reason)`.
 * Its runtime contract and `string[]` result differ, so callers must migrate
 * deliberately. This compatibility API will be removed in the next major
 * release (#16470).
 */
export function abortInflightInference(runtime: IAgentRuntime): {
  aborted: number;
} {
  const set = trackers.get(runtime);
  if (!set || set.size === 0) {
    return { aborted: 0 };
  }
  const count = set.size;
  for (const controller of set) {
    controller.abort();
  }
  set.clear();
  return { aborted: count };
}

/**
 * Inspect the current in-flight count without aborting. Used by
 * diagnostics endpoints (e.g. `/api/health` extension) and tests.
 *
 * @deprecated Inspect the runtime-owned TurnControllerRegistry instead. This
 * compatibility API will be removed in the next major release (#16470).
 */
export function getInflightInferenceCount(runtime: IAgentRuntime): number {
  return trackers.get(runtime)?.size ?? 0;
}

/**
 * Test-only reset. Wipes the runtime's tracker entirely. Do NOT call
 * from production code.
 *
 * @internal
 *
 * @deprecated Core's TurnControllerRegistry owns inference cancellation. This
 * compatibility test helper will be removed with the registry (#16470).
 */
export function __resetInflightInferenceForTests(runtime: IAgentRuntime): void {
  trackers.delete(runtime);
}
