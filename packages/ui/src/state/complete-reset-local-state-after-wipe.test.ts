/**
 * Unit coverage for the post-server-wipe local-state reset: verifies persisted
 * state is cleared and the shell returns to first-run. Deps injected, no harness.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentStatus, FirstRunOptions } from "../api/client";
import {
  type CompleteResetLocalStateDeps,
  completeResetLocalStateAfterServerWipe,
} from "./complete-reset-local-state-after-wipe";

const okOptions = {
  names: [],
  styles: [
    {
      id: "a",
      name: "A",
      avatarIndex: 0,
      voicePresetId: "default",
      greetingAnimation: "idle",
      catchphrase: "",
      hint: "",
      bio: [],
      system: "",
      adjectives: [],
      style: { all: [], chat: [], post: [] },
      topics: [],
      postExamples: [],
      messageExamples: [],
    },
  ],
  providers: [],
  cloudProviders: [],
  models: {},
  inventoryProviders: [],
  sharedStyleRules: "",
} satisfies FirstRunOptions;

function buildSpyDeps(overrides: Partial<CompleteResetLocalStateDeps> = {}): {
  deps: CompleteResetLocalStateDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const trace =
    (label: string) =>
    (..._args: unknown[]): void => {
      calls.push(label);
    };
  const traceAsync =
    <T>(label: string, value: T) =>
    async (): Promise<T> => {
      calls.push(label);
      return value;
    };
  const deps: CompleteResetLocalStateDeps = {
    setAgentStatus: trace("setAgentStatus"),
    resetClientConnection: trace("resetClientConnection"),
    clearPersistedActiveServer: trace("clearPersistedActiveServer"),
    clearPersistedAvatarIndex: trace("clearPersistedAvatarIndex"),
    setClientBaseUrl: trace("setClientBaseUrl"),
    setClientToken: trace("setClientToken"),
    clearElizaCloudSessionUi: trace("clearElizaCloudSessionUi"),
    markFirstRunReset: trace("markFirstRunReset"),
    resetAvatarSelection: trace("resetAvatarSelection"),
    clearConversationLists: trace("clearConversationLists"),
    clearRendererStorage: traceAsync("clearRendererStorage", undefined),
    fetchFirstRunOptions: traceAsync("fetchFirstRunOptions", okOptions),
    setFirstRunOptions: trace("setFirstRunOptions"),
    logResetDebug: () => {},
    logResetWarn: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("completeResetLocalStateAfterServerWipe", () => {
  it("fires deps in the documented atomicity order", async () => {
    const { deps, calls } = buildSpyDeps();
    await completeResetLocalStateAfterServerWipe(null, deps);
    expect(calls).toEqual([
      "resetClientConnection",
      "clearRendererStorage",
      "setAgentStatus",
      "clearPersistedActiveServer",
      "clearPersistedAvatarIndex",
      "setClientBaseUrl",
      "setClientToken",
      "clearElizaCloudSessionUi",
      "markFirstRunReset",
      "resetAvatarSelection",
      "clearConversationLists",
      "fetchFirstRunOptions",
      "setFirstRunOptions",
    ]);
  });

  it("clears renderer storage before UI callbacks and before reloading options", async () => {
    const { deps, calls } = buildSpyDeps();
    await completeResetLocalStateAfterServerWipe(null, deps);
    const storageIdx = calls.indexOf("clearRendererStorage");
    expect(storageIdx).toBe(calls.indexOf("resetClientConnection") + 1);
    expect(calls.indexOf("setAgentStatus")).toBe(storageIdx + 1);
    expect(calls.indexOf("fetchFirstRunOptions")).toBe(
      calls.indexOf("clearConversationLists") + 1,
    );
  });

  it("waits for renderer storage deletion before fetching first-run options", async () => {
    let releaseStorage: (() => void) | undefined;
    const clearRendererStorage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStorage = resolve;
        }),
    );
    const fetchFirstRunOptions = vi.fn(async () => okOptions);
    const { deps } = buildSpyDeps({
      clearRendererStorage,
      fetchFirstRunOptions,
    });

    const resetPromise = completeResetLocalStateAfterServerWipe(null, deps);
    await Promise.resolve();

    expect(clearRendererStorage).toHaveBeenCalledTimes(1);
    expect(fetchFirstRunOptions).not.toHaveBeenCalled();

    releaseStorage?.();
    await resetPromise;
    expect(fetchFirstRunOptions).toHaveBeenCalledTimes(1);
  });

  it("forwards the post-reset agent status to setAgentStatus", async () => {
    const setAgentStatus = vi.fn();
    const { deps } = buildSpyDeps({ setAgentStatus });
    const status = {
      state: "stopped",
      agentName: "test-agent",
      model: undefined,
      uptime: undefined,
      startedAt: undefined,
    } satisfies AgentStatus;
    await completeResetLocalStateAfterServerWipe(status, deps);
    expect(setAgentStatus).toHaveBeenCalledWith(status);
  });

  it("absorbs fetchFirstRunOptions failure without rolling back the wipe", async () => {
    const setFirstRunOptions = vi.fn();
    const logResetWarn = vi.fn();
    const { deps, calls } = buildSpyDeps({
      fetchFirstRunOptions: async () => {
        throw new Error("network down");
      },
      setFirstRunOptions,
      logResetWarn,
    });
    await expect(
      completeResetLocalStateAfterServerWipe(null, deps),
    ).resolves.toBeUndefined();
    expect(setFirstRunOptions).not.toHaveBeenCalled();
    expect(logResetWarn).toHaveBeenCalledWith(
      "resetLocalState: getFirstRunOptions failed after reset",
      expect.any(Error),
    );
    expect(calls).toContain("clearConversationLists");
    expect(calls).not.toContain("setFirstRunOptions");
  });

  it("propagates a failure from any non-fetch callback (no silent swallow)", async () => {
    const { deps } = buildSpyDeps({
      markFirstRunReset: () => {
        throw new Error("setter exploded");
      },
    });
    await expect(
      completeResetLocalStateAfterServerWipe(null, deps),
    ).rejects.toThrow("setter exploded");
  });

  it("propagates renderer storage deletion failure", async () => {
    const fetchFirstRunOptions = vi.fn(async () => okOptions);
    const { deps } = buildSpyDeps({
      clearRendererStorage: async () => {
        throw new Error("native credential survived");
      },
      fetchFirstRunOptions,
    });

    await expect(
      completeResetLocalStateAfterServerWipe(null, deps),
    ).rejects.toThrow("native credential survived");
    expect(fetchFirstRunOptions).not.toHaveBeenCalled();
  });

  it("still clears renderer credentials when connection teardown throws", async () => {
    const clearRendererStorage = vi.fn(async () => undefined);
    const setAgentStatus = vi.fn();
    const { deps } = buildSpyDeps({
      resetClientConnection: () => {
        throw new Error("connection teardown exploded");
      },
      clearRendererStorage,
      setAgentStatus,
    });

    await expect(
      completeResetLocalStateAfterServerWipe(null, deps),
    ).rejects.toThrow("connection teardown exploded");
    expect(clearRendererStorage).toHaveBeenCalledOnce();
    expect(setAgentStatus).not.toHaveBeenCalled();
  });
});
