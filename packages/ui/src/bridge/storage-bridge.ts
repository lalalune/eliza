/**
 * Storage Bridge
 *
 * This module provides a bridge between the web UI's localStorage usage
 * and Capacitor's Preferences plugin for native platforms. On web, it
 * passes through to localStorage. On native, it uses Preferences for
 * more reliable persistence.
 *
 * The bridge works by intercepting localStorage calls via a proxy and
 * syncing with Capacitor Preferences on native platforms.
 */

import { Capacitor } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "../first-run/mobile-runtime-mode";
import { runAsPrivilegedShell } from "../surface-realm-channel";

/**
 * Lazy-load the @capacitor/preferences module on demand. Keeping it out of the
 * static module graph means server consumers that pull in the @elizaos/ui barrel
 * (e.g. plugin-inbox in the Node agent image) don't crash resolving a
 * native-only, mobile-only devDependency. Only ever invoked behind an
 * `isNativePlatform()` guard.
 *
 * Returns the module namespace, NOT the bare `Preferences` plugin. The plugin is
 * a Capacitor proxy whose `.then` resolves to a function, which makes it
 * *thenable*: resolving any promise (an async return or a `.then` callback)
 * with the bare proxy triggers the Promise resolution procedure, which calls
 * `proxy.then(resolve, reject)`. On Android that throws
 * `"Preferences.then()" is not implemented` AND the proxy's `.then` ignores the
 * resolve/reject it was handed, so the adopting promise never settles —
 * `await loadPreferences()` would hang forever and block boot. The module
 * namespace has no `then` export, so it is safe to await; callers destructure
 * `{ Preferences }` and only ever resolve promises with method-call results.
 */
function loadPreferences() {
  return import("@capacitor/preferences");
}

function isNativePlatform(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return (
      Capacitor.isNativePlatform() ||
      platform === "ios" ||
      platform === "android"
    );
  } catch {
    // error-policy:J4 no Capacitor bridge → web runtime; treat as non-native.
    return false;
  }
}

// Keys that should be synced to Capacitor Preferences.
// On iOS, WKWebView localStorage can be purged under memory pressure.
// These keys are critical for session restoration on mobile.
const SYNCED_KEYS = new Set([
  "eliza.control.settings.v1",
  "eliza.device.identity",
  "eliza.device.auth",
  // The Eliza Cloud session (#13377): with cloud-only onboarding this is THE
  // credential — losing it to a WKWebView purge signs the user out and, mid-
  // onboarding, restarts the sign-in ask (the mobile "login loop"). Same
  // durability class as eliza.device.auth above.
  STEWARD_TOKEN_KEY,
  "elizaos:active-server",
  "eliza:first-run-complete",
  "eliza:setup:step",
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  // `useAppLifecycleEvents` writes this on APP_PAUSE so the next
  // foreground can rehydrate the same conversation even after the
  // WKWebView localStorage was purged under memory pressure.
  "eliza:chat:activeConversationId",
  "eliza:ios-local-agent:conversations:v1",
  "eliza:ios-local-agent:active-model:v1",
  "eliza:ios-local-agent:assignments:v1",
  "eliza:ios-local-agent:browser-workspace:v1",
  "eliza:ios-local-agent:wallet-market-overview:v1",
  "eliza:ios-local-agent:eliza-1-bundles:v1",
  "eliza:ios-full-bun-smoke:request",
  "eliza:ios-full-bun-smoke:result",
  "eliza:ios-onboarding-smoke:request",
  "eliza:ios-onboarding-smoke:result",
  "eliza:ios-onboarding-relaunch-smoke:request",
  "eliza:ios-onboarding-relaunch-smoke:result",
  "eliza:ios-mixed-content-smoke:request",
  "eliza:ios-mixed-content-smoke:result",
  "eliza:ios-attachment-smoke:request",
  "eliza:ios-attachment-smoke:result",
  "eliza:ios-voice-selftest:request",
  "eliza:ios-voice-selftest:result",
  // Harness wallet for zero-interaction SIWE e2e (#13377): device harnesses
  // seed these via native Preferences before first launch; the install itself
  // is gated off store builds (platform/e2e-wallet.ts).
  "eliza:e2e-wallet:pk",
  "eliza:e2e-wallet:autologin",
]);

// In-memory cache of values from Preferences (for native)
const preferencesCache = new Map<string, string>();

// Native writes are normally fire-and-forget so synchronous localStorage calls
// stay fast. Destructive reset is the exception: it advances the generation,
// drains mutations already inside the native bridge, then removes and verifies
// every synced key. A queued pre-reset write therefore cannot repopulate a
// credential after reset has returned.
let storageMutationGeneration = 0;
let storageResetInProgress = false;
let storageResetPromise: Promise<void> | null = null;
const pendingNativeMutations = new Set<Promise<void>>();

// Flag to track if initial sync has completed
let initialized = false;
let storageProxyInstalled = false;

const PREFERENCE_READ_TIMEOUT_MS = 1_500;
// Warm-up probe before hydration: retry a few times so a cold native bridge
// doesn't drop critical synced keys (first-run-complete, active-server, …).
const PREFERENCE_HYDRATION_ATTEMPTS = 6;
const PREFERENCE_HYDRATION_RETRY_MS = 350;

function trackNativeMutation(operation: Promise<void>): Promise<void> {
  let tracked: Promise<void>;
  tracked = operation.finally(() => {
    pendingNativeMutations.delete(tracked);
  });
  pendingNativeMutations.add(tracked);
  return tracked;
}

function scheduleSyncedPreferenceMutation(
  key: string,
  mutate: (
    preferences: typeof import("@capacitor/preferences").Preferences,
  ) => Promise<void>,
  failureMessage: string,
): void {
  const generation = storageMutationGeneration;
  setTimeout(() => {
    if (storageResetInProgress || generation !== storageMutationGeneration) {
      return;
    }
    const mutation = trackNativeMutation(
      loadPreferences().then(async ({ Preferences }) => {
        if (
          storageResetInProgress ||
          generation !== storageMutationGeneration
        ) {
          return;
        }
        await mutate(Preferences);
      }),
    );
    void mutation.catch((err) => {
      logger.error({ err, key }, failureMessage);
    });
  }, 0);
}

/**
 * Resolve `true` as soon as the native Preferences plugin answers a call (even
 * with a null value), `false` if it times out (still cold). Used to warm up the
 * bridge before hydration so a cold plugin doesn't silently drop synced keys.
 */
async function preferencesResponded(): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<false>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), PREFERENCE_READ_TIMEOUT_MS);
    });
    const { Preferences } = await loadPreferences();
    const probe = Preferences.get({ key: "eliza:first-run-complete" }).then(
      () => true as const,
    );
    return await Promise.race([probe, timeout]);
  } catch {
    // error-policy:J4 probe contract is "did the plugin answer?"; a thrown
    // read means it did not (still cold) — the caller retries.
    return false;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function readPreferenceWithTimeout(key: string): Promise<string | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), PREFERENCE_READ_TIMEOUT_MS);
    });
    const { Preferences } = await loadPreferences();
    const result = await Promise.race([Preferences.get({ key }), timeout]);
    return result?.value ?? null;
  } catch {
    // error-policy:J4 hydration read is best-effort; a failed/timed-out read
    // skips this key for the pass. The warm-up probe gates `initialized`, so a
    // cold bridge re-hydrates rather than permanently dropping the key.
    return null;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

/**
 * Initialize the storage bridge
 *
 * On native platforms, this loads values from Capacitor Preferences
 * into the in-memory cache and optionally syncs them to localStorage.
 */
export async function initializeStorageBridge(): Promise<void> {
  if (initialized) {
    return;
  }

  if (!isNativePlatform()) {
    return;
  }

  const hydrationGeneration = storageMutationGeneration;
  if (storageResetInProgress) {
    setupStorageProxy();
    return;
  }

  // The Capacitor Preferences plugin is frequently not yet responsive on the
  // first read during very early WebView startup (the bridge is still wiring
  // up), so a single best-effort pass loses critical session/first-run state —
  // e.g. `eliza:first-run-complete` fails to hydrate and the user is bounced
  // back into onboarding even though native Preferences has it. Probe one key
  // with a few short retries until the plugin answers, then hydrate. The probe
  // can't distinguish "plugin cold" from "key genuinely unset", so it is capped
  // and never blocks first paint for more than a moment.
  let pluginResponded = false;
  for (let attempt = 0; attempt < PREFERENCE_HYDRATION_ATTEMPTS; attempt += 1) {
    if (await preferencesResponded()) {
      pluginResponded = true;
      break;
    }
    if (attempt < PREFERENCE_HYDRATION_ATTEMPTS - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, PREFERENCE_HYDRATION_RETRY_MS),
      );
    }
  }

  if (
    storageResetInProgress ||
    hydrationGeneration !== storageMutationGeneration
  ) {
    setupStorageProxy();
    return;
  }

  // Load synced keys from Preferences into cache. Hydration stays best-effort so
  // a single stale preference read cannot block first paint.
  const entries = await Promise.all(
    Array.from(
      SYNCED_KEYS,
      async (key) => [key, await readPreferenceWithTimeout(key)] as const,
    ),
  );
  if (
    storageResetInProgress ||
    hydrationGeneration !== storageMutationGeneration
  ) {
    setupStorageProxy();
    return;
  }
  for (const [key, value] of entries) {
    if (value === null) continue;
    preferencesCache.set(key, value);
    // Also set in localStorage for immediate availability. Privileged: the
    // synced keys are shell-reserved and re-hydration can run after mount
    // (cold-plugin retry), i.e. while a surface scope has the raw guard armed.
    try {
      runAsPrivilegedShell(() => window.localStorage.setItem(key, value));
    } catch {
      // error-policy:J4 localStorage mirror is best-effort; the authoritative
      // copy lives in `preferencesCache` (set above). A quota/private-mode
      // write failure must not abort hydration of the remaining keys.
    }
  }

  // Set up the storage proxy (idempotent) so localStorage<->Preferences sync
  // works even while we wait for a cold plugin to warm up.
  setupStorageProxy();

  // Only consider the bridge initialized once the native plugin has actually
  // answered. If it never warmed up, leave `initialized` false so a later call
  // (e.g. from initializePlatform after more of the bridge has wired up)
  // re-hydrates instead of permanently dropping critical synced keys —
  // first-run-complete, active-server, the smoke request — which otherwise
  // strands the user in onboarding or silently skips the QA smoke.
  if (
    pluginResponded &&
    !storageResetInProgress &&
    hydrationGeneration === storageMutationGeneration
  ) {
    initialized = true;
  }
}

/**
 * Set up a proxy to intercept localStorage operations
 */
function setupStorageProxy(): void {
  if (storageProxyInstalled) {
    return;
  }

  if (!isNativePlatform()) {
    return;
  }

  const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
  const originalGetItem = window.localStorage.getItem.bind(window.localStorage);
  const originalRemoveItem = window.localStorage.removeItem.bind(
    window.localStorage,
  );

  // Override setItem
  window.localStorage.setItem = (key: string, value: string): void => {
    if (SYNCED_KEYS.has(key) && storageResetInProgress) {
      return;
    }
    // Always set in localStorage first
    originalSetItem(key, value);

    // If it's a synced key, also persist to Preferences
    if (SYNCED_KEYS.has(key)) {
      preferencesCache.set(key, value);
      // Fire and forget on a later task. Some native bridge calls can stall
      // during early WebView startup; localStorage writes must stay sync-fast.
      scheduleSyncedPreferenceMutation(
        key,
        (Preferences) => Preferences.set({ key, value }),
        "[StorageBridge] failed to sync key to Preferences",
      );
    }
  };

  // Override getItem
  window.localStorage.getItem = (key: string): string | null => {
    // For synced keys, prefer the cache (which was loaded from Preferences)
    if (SYNCED_KEYS.has(key) && preferencesCache.has(key)) {
      return preferencesCache.get(key) ?? null;
    }
    return originalGetItem(key);
  };

  // Override removeItem
  window.localStorage.removeItem = (key: string): void => {
    originalRemoveItem(key);

    if (SYNCED_KEYS.has(key)) {
      preferencesCache.delete(key);
      if (storageResetInProgress) return;
      scheduleSyncedPreferenceMutation(
        key,
        (Preferences) => Preferences.remove({ key }),
        "[StorageBridge] failed to remove key from Preferences",
      );
    }
  };

  storageProxyInstalled = true;
}

/**
 * Get a value from storage (works on both native and web)
 */
export async function getStorageValue(key: string): Promise<string | null> {
  if (isNativePlatform() && SYNCED_KEYS.has(key)) {
    const { Preferences } = await loadPreferences();
    const result = await Preferences.get({ key });
    return result.value;
  }
  return window.localStorage.getItem(key);
}

/**
 * Set a value in storage (works on both native and web)
 */
export async function setStorageValue(
  key: string,
  value: string,
): Promise<void> {
  if (SYNCED_KEYS.has(key) && storageResetInProgress) {
    throw new Error(
      `Cannot persist ${key} while renderer reset is in progress`,
    );
  }
  // Privileged: this is the shell-side persistence helper (session/auth/
  // first-run keys); the view-facing path is the scoped override in
  // DynamicViewLoader's bridge compat, not this function.
  runAsPrivilegedShell(() => window.localStorage.setItem(key, value));

  if (isNativePlatform() && SYNCED_KEYS.has(key)) {
    const generation = storageMutationGeneration;
    await trackNativeMutation(
      loadPreferences().then(async ({ Preferences }) => {
        if (
          storageResetInProgress ||
          generation !== storageMutationGeneration
        ) {
          return;
        }
        await Preferences.set({ key, value });
      }),
    );
  }
}

/**
 * Remove a value from storage (works on both native and web)
 */
export async function removeStorageValue(key: string): Promise<void> {
  runAsPrivilegedShell(() => window.localStorage.removeItem(key));

  if (isNativePlatform() && SYNCED_KEYS.has(key)) {
    if (storageResetInProgress) return;
    const generation = storageMutationGeneration;
    await trackNativeMutation(
      loadPreferences().then(async ({ Preferences }) => {
        if (
          storageResetInProgress ||
          generation !== storageMutationGeneration
        ) {
          return;
        }
        await Preferences.remove({ key });
      }),
    );
  }
}

/**
 * Removes every renderer key mirrored into Capacitor Preferences and waits for
 * native deletion to finish. Reset callers use this instead of synchronous
 * `localStorage.removeItem`: iOS/Android must not rehydrate a stale token or
 * first-run marker after the server-side wipe has completed.
 */
export function clearSyncedStorageForReset(): Promise<void> {
  if (storageResetPromise) return storageResetPromise;

  const reset = async (): Promise<void> => {
    storageResetInProgress = true;
    storageMutationGeneration += 1;
    const errors: unknown[] = [];

    // A mutation already executing inside Preferences may still land after the
    // generation changes. Drain it before deletion so removal is the final write.
    const pendingResults = await Promise.allSettled([
      ...pendingNativeMutations,
    ]);
    for (const result of pendingResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    const keys = [...SYNCED_KEYS];
    preferencesCache.clear();
    if (typeof window !== "undefined") {
      for (const key of keys) {
        try {
          runAsPrivilegedShell(() => window.localStorage.removeItem(key));
        } catch (error) {
          // error-policy:J1 reset attempts every independent browser/native key
          // and reports the complete set of failed deletions at the boundary.
          errors.push(error);
        }
      }
    }

    if (isNativePlatform()) {
      const [preferencesResult] = await Promise.allSettled([loadPreferences()]);
      if (preferencesResult.status === "rejected") {
        errors.push(preferencesResult.reason);
      } else {
        const { Preferences } = preferencesResult.value;
        const removalResults = await Promise.allSettled(
          keys.map((key) => Preferences.remove({ key })),
        );
        for (const [index, result] of removalResults.entries()) {
          if (result.status === "rejected") {
            errors.push(
              new Error(`Failed to remove native renderer key ${keys[index]}`, {
                cause: result.reason,
              }),
            );
          }
        }

        const verificationResults = await Promise.allSettled(
          keys.map(async (key) => ({
            key,
            value: (await Preferences.get({ key })).value,
          })),
        );
        const remaining: string[] = [];
        for (const [index, result] of verificationResults.entries()) {
          if (result.status === "rejected") {
            errors.push(
              new Error(`Failed to verify native renderer key ${keys[index]}`, {
                cause: result.reason,
              }),
            );
          } else if (result.value.value !== null) {
            remaining.push(result.value.key);
          }
        }
        if (remaining.length > 0) {
          errors.push(
            new Error(
              `Native renderer state survived reset: ${remaining.join(", ")}`,
            ),
          );
        }
      }
    }

    if (typeof window !== "undefined") {
      const remaining: string[] = [];
      for (const key of keys) {
        try {
          if (window.localStorage.getItem(key) !== null) remaining.push(key);
        } catch (error) {
          // error-policy:J1 verification failures are preserved while every key
          // is still checked before the destructive reset boundary returns.
          errors.push(error);
        }
      }
      if (remaining.length > 0) {
        errors.push(
          new Error(
            `Renderer localStorage survived reset: ${remaining.join(", ")}`,
          ),
        );
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Synced renderer storage reset failed");
    }
  };

  storageResetPromise = reset().finally(() => {
    storageResetInProgress = false;
    storageResetPromise = null;
  });
  return storageResetPromise;
}

/**
 * Register additional keys to be synced to Preferences
 */
export function registerSyncedKey(key: string): void {
  SYNCED_KEYS.add(key);
}

/**
 * Check if storage bridge is initialized
 */
export function isStorageBridgeInitialized(): boolean {
  return initialized;
}
