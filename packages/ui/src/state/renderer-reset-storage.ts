/**
 * Erases credential-bearing renderer state after the server has completed a
 * destructive agent reset. Browser, process-global, and Capacitor Preferences
 * copies are cleared as one awaited postcondition so a native relaunch cannot
 * restore a token or pending OAuth flow from before the reset.
 */

import {
  STEWARD_AUTHED_COOKIE,
  STEWARD_REFRESH_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { CSRF_COOKIE_NAME } from "../api/auth/sessions";
import { client } from "../api/client";
import { clearSyncedStorageForReset } from "../bridge/storage-bridge";
import { clearOneTimeAppApiKeysForReset } from "../cloud/applications/lib/one-time-app-api-key";
import { SUBSCRIPTION_OAUTH_STORAGE_PREFIX } from "../components/accounts/subscription-oauth-state";
import { getBootConfig } from "../config/boot-config";
import { CLOUD_RESUME_STORAGE_KEY } from "../first-run/first-run-cloud-resume";
import { shellHistory, shellLocalStorage } from "../surface-realm-channel";
import { clearElizaApiToken } from "../utils/eliza-globals";
import { scrubPersistedAgentProfileTokensForReset } from "./agent-profiles";
import {
  ANONYMOUS_CLOUD_SESSION_STORAGE_KEY,
  BOOTSTRAP_SESSION_STORAGE_KEY,
  beginRendererCredentialReset,
  CLOUD_PAIR_SESSION_STORAGE_KEY,
  finishRendererCredentialReset,
} from "./credential-storage-keys";

const RESET_LOCAL_STORAGE_KEYS = [
  STEWARD_REFRESH_TOKEN_KEY,
  ANONYMOUS_CLOUD_SESSION_STORAGE_KEY,
  CLOUD_RESUME_STORAGE_KEY,
  "eliza.settings.anthropic.oauth-active",
  "eliza.settings.openai.oauth-active",
] as const;

const RESET_SESSION_STORAGE_KEYS = [
  CLOUD_PAIR_SESSION_STORAGE_KEY,
  BOOTSTRAP_SESSION_STORAGE_KEY,
] as const;

const RESET_URL_SEARCH_PARAMS = [
  "apiBase",
  "token",
  "cloudLaunchSession",
  "cloudLaunchBase",
  "elizaCloudLogin",
  "elizaCloudLoginSession",
] as const;
const BOOTSTRAP_HASH_PARAM = "bootstrap";

const LEGACY_BOOT_CONFIG_KEY = "__ELIZA_APP_BOOT_CONFIG__";
let rendererResetPromise: Promise<void> | null = null;

function subscriptionOAuthStorageKeys(): string[] {
  if (typeof localStorage === "undefined") return [];
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${SUBSCRIPTION_OAUTH_STORAGE_PREFIX}:`)) {
      keys.push(key);
    }
  }
  return keys;
}

function writeReadableCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: reset must expire readable auth markers on browsers without Cookie Store support.
  document.cookie = value;
}

function expireReadableCookie(name: string): void {
  if (typeof document === "undefined") return;
  writeReadableCookie(`${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  if (window.location.hostname.endsWith("elizacloud.ai")) {
    writeReadableCookie(
      `${name}=; Path=/; Domain=.elizacloud.ai; Max-Age=0; SameSite=Lax`,
    );
  }
}

function collectCleanupError(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    // error-policy:J1 destructive reset reports every failed cleanup operation
    // together after all independent credential stores have been attempted.
    errors.push(error);
  }
}

function scrubCredentialUrlState(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;

  if (url.searchParams.get("setup") === "oauth") {
    url.searchParams.delete("setup");
    changed = true;
  }
  for (const key of RESET_URL_SEARCH_PARAMS) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  if (url.pathname.replace(/\/+$/, "") === "/pair") {
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      changed = true;
    }
  }

  if (url.hash.length > 1) {
    const hashParams = new URLSearchParams(url.hash.slice(1));
    if (hashParams.has(BOOTSTRAP_HASH_PARAM)) {
      hashParams.delete(BOOTSTRAP_HASH_PARAM);
      const remainingHash = hashParams.toString();
      url.hash = remainingHash ? `#${remainingHash}` : "";
      changed = true;
    }
  }

  if (changed) shellHistory.replaceState(window.history.state, "", url);
}

function resetBrowserAndModuleCredentialState(errors: unknown[]): void {
  collectCleanupError(errors, clearOneTimeAppApiKeysForReset);
  collectCleanupError(errors, () => client.setToken(null));
  collectCleanupError(errors, clearElizaApiToken);
  collectCleanupError(errors, () => {
    // Some older host shims still read this mirror instead of the canonical
    // boot-config window slot, so both must expose the same token-free object.
    (globalThis as Record<string, unknown>)[LEGACY_BOOT_CONFIG_KEY] =
      getBootConfig();
  });
  collectCleanupError(errors, scrubPersistedAgentProfileTokensForReset);

  collectCleanupError(errors, () => {
    if (typeof localStorage === "undefined") return;
    const keys = [
      ...RESET_LOCAL_STORAGE_KEYS,
      ...subscriptionOAuthStorageKeys(),
    ];
    for (const key of keys) {
      collectCleanupError(errors, () => shellLocalStorage.removeItem(key));
    }
  });

  collectCleanupError(errors, () => {
    if (typeof sessionStorage === "undefined") return;
    for (const key of RESET_SESSION_STORAGE_KEYS) {
      collectCleanupError(errors, () => sessionStorage.removeItem(key));
    }
  });

  collectCleanupError(errors, scrubCredentialUrlState);

  for (const cookieName of [
    CSRF_COOKIE_NAME,
    STEWARD_AUTHED_COOKIE,
    `${STEWARD_AUTHED_COOKIE}-staging`,
    `${STEWARD_AUTHED_COOKIE}-dev`,
  ]) {
    collectCleanupError(errors, () => expireReadableCookie(cookieName));
  }
}

function verifyBrowserAndModuleCredentialState(errors: unknown[]): void {
  collectCleanupError(errors, () => {
    if (client.apiToken !== null || getBootConfig().apiToken !== undefined) {
      throw new Error("Renderer API token survived reset");
    }
  });

  collectCleanupError(errors, () => {
    const legacyConfig = (globalThis as Record<string, unknown>)[
      LEGACY_BOOT_CONFIG_KEY
    ];
    if (
      !legacyConfig ||
      typeof legacyConfig !== "object" ||
      "apiToken" in legacyConfig
    ) {
      throw new Error("Legacy renderer boot token survived reset");
    }
  });

  collectCleanupError(errors, () => {
    if (typeof localStorage === "undefined") return;
    const remaining = [
      ...RESET_LOCAL_STORAGE_KEYS,
      ...subscriptionOAuthStorageKeys(),
    ].filter((key) => localStorage.getItem(key) !== null);
    if (remaining.length > 0) {
      throw new Error(
        `Credential-bearing localStorage survived reset: ${remaining.join(", ")}`,
      );
    }
  });

  collectCleanupError(errors, () => {
    if (typeof sessionStorage === "undefined") return;
    const remaining = RESET_SESSION_STORAGE_KEYS.filter(
      (key) => sessionStorage.getItem(key) !== null,
    );
    if (remaining.length > 0) {
      throw new Error(
        `Credential-bearing sessionStorage survived reset: ${remaining.join(", ")}`,
      );
    }
  });

  collectCleanupError(errors, () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const remainingSearchParams: string[] = RESET_URL_SEARCH_PARAMS.filter(
      (key) => url.searchParams.has(key),
    );
    if (url.searchParams.get("setup") === "oauth") {
      remainingSearchParams.push("setup");
    }
    const hashParams = new URLSearchParams(url.hash.slice(1));
    if (hashParams.has(BOOTSTRAP_HASH_PARAM)) {
      remainingSearchParams.push(`#${BOOTSTRAP_HASH_PARAM}`);
    }
    if (remainingSearchParams.length > 0) {
      throw new Error(
        `Credential-bearing URL state survived reset: ${remainingSearchParams.join(", ")}`,
      );
    }
  });
}

/** Clears and verifies every renderer credential/state copy owned by reset. */
export function clearRendererStorageForReset(): Promise<void> {
  if (rendererResetPromise) return rendererResetPromise;

  const reset = async (): Promise<void> => {
    const generation = beginRendererCredentialReset();
    const errors: unknown[] = [];
    try {
      // The native bridge is awaited between two browser sweeps because a
      // writer already awaiting a response may settle while Preferences drains.
      resetBrowserAndModuleCredentialState(errors);
      try {
        await clearSyncedStorageForReset();
      } catch (error) {
        // error-policy:J1 native cleanup failure joins the renderer reset result
        // without skipping the final browser sweep and verification.
        errors.push(error);
      }
      resetBrowserAndModuleCredentialState(errors);
      verifyBrowserAndModuleCredentialState(errors);

      if (errors.length > 0) {
        throw new AggregateError(errors, "Renderer credential reset failed");
      }
    } finally {
      finishRendererCredentialReset(generation);
    }
  };

  rendererResetPromise = reset().finally(() => {
    rendererResetPromise = null;
  });
  return rendererResetPromise;
}
