// @vitest-environment jsdom

/**
 * Native reset coverage for the localStorage/Capacitor Preferences bridge.
 * Capacitor is mocked, including delayed writes/removals that exercise races.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeStorage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const state: {
    blockedSetKey: string | null;
    blockedGetKey: string | null;
    blockedRemoveKey: string | null;
    failedRemoveKey: string | null;
    releaseGet: (() => void) | undefined;
    releaseSet: (() => void) | undefined;
    releaseRemove: (() => void) | undefined;
  } = {
    blockedSetKey: null,
    blockedGetKey: null,
    blockedRemoveKey: null,
    failedRemoveKey: null,
    releaseGet: undefined,
    releaseSet: undefined,
    releaseRemove: undefined,
  };

  return {
    values,
    state,
    get: vi.fn(
      ({ key }: { key: string }): Promise<{ value: string | null }> => {
        const value = values.get(key) ?? null;
        if (state.blockedGetKey === key && !state.releaseGet) {
          return new Promise<{ value: string | null }>((resolve) => {
            state.releaseGet = () => resolve({ value });
          });
        }
        return Promise.resolve({ value });
      },
    ),
    set: vi.fn(
      ({ key, value }: { key: string; value: string }): Promise<void> => {
        if (state.blockedSetKey === key) {
          return new Promise<void>((resolve) => {
            state.releaseSet = () => {
              values.set(key, value);
              resolve();
            };
          });
        }
        values.set(key, value);
        return Promise.resolve();
      },
    ),
    remove: vi.fn(({ key }: { key: string }): Promise<void> => {
      if (state.failedRemoveKey === key) {
        return Promise.reject(new Error(`injected removal failure: ${key}`));
      }
      if (state.blockedRemoveKey === key) {
        return new Promise<void>((resolve) => {
          state.releaseRemove = () => {
            values.delete(key);
            resolve();
          };
        });
      }
      values.delete(key);
      return Promise.resolve();
    }),
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: nativeStorage.get,
    set: nativeStorage.set,
    remove: nativeStorage.remove,
  },
}));

import {
  clearSyncedStorageForReset,
  initializeStorageBridge,
  setStorageValue,
} from "./storage-bridge";

describe("clearSyncedStorageForReset", () => {
  beforeEach(() => {
    localStorage.clear();
    nativeStorage.values.clear();
    nativeStorage.state.blockedSetKey = null;
    nativeStorage.state.blockedGetKey = null;
    nativeStorage.state.blockedRemoveKey = null;
    nativeStorage.state.failedRemoveKey = null;
    nativeStorage.state.releaseGet = undefined;
    nativeStorage.state.releaseSet = undefined;
    nativeStorage.state.releaseRemove = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    nativeStorage.state.releaseSet?.();
    nativeStorage.state.releaseGet?.();
    nativeStorage.state.releaseRemove?.();
    nativeStorage.state.blockedSetKey = null;
    nativeStorage.state.blockedGetKey = null;
    nativeStorage.state.blockedRemoveKey = null;
    nativeStorage.state.failedRemoveKey = null;
    nativeStorage.state.releaseGet = undefined;
    await clearSyncedStorageForReset();
    localStorage.clear();
    nativeStorage.values.clear();
  });

  it("drains an in-flight native write before making deletion the final mutation", async () => {
    nativeStorage.state.blockedSetKey = STEWARD_TOKEN_KEY;
    const writePromise = setStorageValue(STEWARD_TOKEN_KEY, "stale-token");
    await vi.waitFor(() => {
      expect(nativeStorage.state.releaseSet).toBeTypeOf("function");
    });

    const resetPromise = clearSyncedStorageForReset();
    await Promise.resolve();

    expect(nativeStorage.remove).not.toHaveBeenCalled();
    nativeStorage.state.releaseSet?.();
    await writePromise;
    await resetPromise;

    expect(nativeStorage.values.get(STEWARD_TOKEN_KEY)).toBeUndefined();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(nativeStorage.remove).toHaveBeenCalledWith({
      key: STEWARD_TOKEN_KEY,
    });
  });

  it("does not resolve until native deletion and verification finish", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "stale-token");
    nativeStorage.values.set(STEWARD_TOKEN_KEY, "stale-token");
    nativeStorage.state.blockedRemoveKey = STEWARD_TOKEN_KEY;

    let settled = false;
    const resetPromise = clearSyncedStorageForReset().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(nativeStorage.state.releaseRemove).toBeTypeOf("function");
    });

    expect(settled).toBe(false);
    expect(nativeStorage.values.get(STEWARD_TOKEN_KEY)).toBe("stale-token");
    nativeStorage.state.releaseRemove?.();
    await resetPromise;

    expect(settled).toBe(true);
    expect(nativeStorage.values.get(STEWARD_TOKEN_KEY)).toBeUndefined();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(nativeStorage.get).toHaveBeenCalledWith({ key: STEWARD_TOKEN_KEY });
  });

  it("waits for every native removal before reporting partial failure", async () => {
    const delayedKey = "eliza.device.auth";
    nativeStorage.values.set(STEWARD_TOKEN_KEY, "stale-token");
    nativeStorage.values.set(delayedKey, "stale-device-auth");
    nativeStorage.state.failedRemoveKey = STEWARD_TOKEN_KEY;
    nativeStorage.state.blockedRemoveKey = delayedKey;

    let settled = false;
    const resetOutcome = clearSyncedStorageForReset().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => {
      expect(nativeStorage.state.releaseRemove).toBeTypeOf("function");
    });

    expect(settled).toBe(false);
    nativeStorage.state.releaseRemove?.();
    const error = await resetOutcome;

    expect(error).toBeInstanceOf(AggregateError);
    expect(nativeStorage.values.get(delayedKey)).toBeUndefined();
    expect(nativeStorage.remove).toHaveBeenCalledWith({ key: delayedKey });
    expect(nativeStorage.get).toHaveBeenCalledWith({ key: STEWARD_TOKEN_KEY });
  });

  it("invalidates a delayed pre-reset hydration read before it can restore stale state", async () => {
    const delayedHydrationKey = "eliza.control.settings.v1";
    nativeStorage.values.set(delayedHydrationKey, "stale-settings");
    nativeStorage.state.blockedGetKey = delayedHydrationKey;

    const hydrationPromise = initializeStorageBridge();
    await vi.waitFor(() => {
      expect(
        nativeStorage.state.releaseGet,
        JSON.stringify(nativeStorage.get.mock.calls),
      ).toBeTypeOf("function");
    });

    await clearSyncedStorageForReset();
    nativeStorage.state.releaseGet?.();
    await hydrationPromise;

    expect(nativeStorage.values.get(delayedHydrationKey)).toBeUndefined();
    expect(localStorage.getItem(delayedHydrationKey)).toBeNull();
    expect(nativeStorage.set).not.toHaveBeenCalledWith({
      key: delayedHydrationKey,
      value: "stale-settings",
    });
  });
});
