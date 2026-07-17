// @vitest-environment jsdom

/**
 * Renderer reset credential cleanup across browser stores and process-global
 * boot state. Capacitor deletion is mocked here and covered at its bridge seam.
 */

import {
  STEWARD_AUTHED_COOKIE,
  STEWARD_REFRESH_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_COOKIE_NAME } from "../api/auth/sessions";
import { client } from "../api/client";
import {
  consumeOneTimeAppApiKey,
  storeOneTimeAppApiKey,
} from "../cloud/applications/lib/one-time-app-api-key";
import { SUBSCRIPTION_OAUTH_STORAGE_PREFIX } from "../components/accounts/subscription-oauth-state";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "../config/boot-config";
import { CLOUD_RESUME_STORAGE_KEY } from "../first-run/first-run-cloud-resume";
import { getElizaApiToken } from "../utils/eliza-globals";
import { saveAgentProfileRegistry } from "./agent-profiles";
import {
  ANONYMOUS_CLOUD_SESSION_STORAGE_KEY,
  BOOTSTRAP_SESSION_STORAGE_KEY,
  CLOUD_PAIR_SESSION_STORAGE_KEY,
  captureRendererCredentialWriteGeneration,
  RendererCredentialResetError,
} from "./credential-storage-keys";

const storageBridgeMocks = vi.hoisted(() => ({
  clearSyncedStorageForReset: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("../bridge/storage-bridge", () => ({
  clearSyncedStorageForReset: storageBridgeMocks.clearSyncedStorageForReset,
}));

import { clearRendererStorageForReset } from "./renderer-reset-storage";

const LEGACY_BOOT_CONFIG_KEY = "__ELIZA_APP_BOOT_CONFIG__";
const PROFILE_STORAGE_KEY = "elizaos:agent-profiles";
const ANTHROPIC_OAUTH_MARKER = "eliza.settings.anthropic.oauth-active";
const OPENAI_OAUTH_MARKER = "eliza.settings.openai.oauth-active";

function setDocumentCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom test seeds the raw auth markers reset must expire.
  document.cookie = value;
}

describe("clearRendererStorageForReset", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/settings?setup=oauth&keep=1");
    client.setToken("client-token");
    setBootConfig({ ...getBootConfig(), apiToken: "boot-token" });
    (globalThis as Record<string, unknown>)[LEGACY_BOOT_CONFIG_KEY] = {
      ...DEFAULT_BOOT_CONFIG,
      apiToken: "legacy-token",
    };
    storageBridgeMocks.clearSyncedStorageForReset.mockReset();
    storageBridgeMocks.clearSyncedStorageForReset.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    client.setToken(null);
    setBootConfig(DEFAULT_BOOT_CONFIG);
    Reflect.deleteProperty(globalThis, LEGACY_BOOT_CONFIG_KEY);
    window.history.replaceState(null, "", "/");
    setDocumentCookie(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`);
    setDocumentCookie(`${STEWARD_AUTHED_COOKIE}=; Path=/; Max-Age=0`);
  });

  it("clears every credential-bearing browser and in-memory copy", async () => {
    window.history.replaceState(
      null,
      "",
      "/pair?setup=oauth&token=pair-url-token&cloudLaunchSession=launch-1&cloudLaunchBase=https%3A%2F%2Fapi.elizacloud.ai&elizaCloudLogin=complete&elizaCloudLoginSession=cloud-session&keep=1#bootstrap=bootstrap-token&keepHash=1",
    );
    localStorage.setItem(STEWARD_REFRESH_TOKEN_KEY, "refresh-token");
    localStorage.setItem(
      ANONYMOUS_CLOUD_SESSION_STORAGE_KEY,
      "anonymous-session",
    );
    localStorage.setItem(CLOUD_RESUME_STORAGE_KEY, "resume-marker");
    localStorage.setItem(ANTHROPIC_OAUTH_MARKER, "true");
    localStorage.setItem(OPENAI_OAUTH_MARKER, "true");
    localStorage.setItem(
      `${SUBSCRIPTION_OAUTH_STORAGE_PREFIX}:anthropic-subscription`,
      JSON.stringify({ codeVerifier: "oauth-secret" }),
    );
    localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeProfileId: "cloud",
        profiles: [
          {
            id: "cloud",
            label: "Cloud",
            kind: "cloud",
            apiBase: "https://agent.example.test",
            accessToken: "profile-token",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    sessionStorage.setItem(CLOUD_PAIR_SESSION_STORAGE_KEY, "pair-token");
    sessionStorage.setItem(BOOTSTRAP_SESSION_STORAGE_KEY, "bootstrap-session");
    storeOneTimeAppApiKey("app-reset", "one-time-key");
    setDocumentCookie(`${CSRF_COOKIE_NAME}=csrf-token; Path=/`);
    setDocumentCookie(`${STEWARD_AUTHED_COOKIE}=1; Path=/`);

    await clearRendererStorageForReset();

    expect(getElizaApiToken()).toBeUndefined();
    expect(client.apiToken).toBeNull();
    expect(getBootConfig().apiToken).toBeUndefined();
    expect(
      (globalThis as Record<string, unknown>)[LEGACY_BOOT_CONFIG_KEY],
    ).toEqual(getBootConfig());
    expect(consumeOneTimeAppApiKey("app-reset")).toBeUndefined();
    expect(localStorage.getItem(STEWARD_REFRESH_TOKEN_KEY)).toBeNull();
    expect(
      localStorage.getItem(ANONYMOUS_CLOUD_SESSION_STORAGE_KEY),
    ).toBeNull();
    expect(localStorage.getItem(CLOUD_RESUME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ANTHROPIC_OAUTH_MARKER)).toBeNull();
    expect(localStorage.getItem(OPENAI_OAUTH_MARKER)).toBeNull();
    expect(
      localStorage.getItem(
        `${SUBSCRIPTION_OAUTH_STORAGE_PREFIX}:anthropic-subscription`,
      ),
    ).toBeNull();
    expect(localStorage.getItem(PROFILE_STORAGE_KEY)).not.toContain(
      "profile-token",
    );
    expect(sessionStorage.getItem(CLOUD_PAIR_SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(BOOTSTRAP_SESSION_STORAGE_KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${CSRF_COOKIE_NAME}=`);
    expect(document.cookie).not.toContain(`${STEWARD_AUTHED_COOKIE}=`);
    expect(new URLSearchParams(window.location.search).get("setup")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("token")).toBeNull();
    expect(
      new URLSearchParams(window.location.search).get("cloudLaunchSession"),
    ).toBeNull();
    expect(
      new URLSearchParams(window.location.search).get("elizaCloudLoginSession"),
    ).toBeNull();
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
    expect(
      new URLSearchParams(window.location.hash.slice(1)).get("bootstrap"),
    ).toBeNull();
    expect(
      new URLSearchParams(window.location.hash.slice(1)).get("keepHash"),
    ).toBe("1");
    expect(
      storageBridgeMocks.clearSyncedStorageForReset,
    ).toHaveBeenCalledOnce();
  });

  it("does not resolve until native synced storage deletion finishes", async () => {
    let releaseNativeDeletion: (() => void) | undefined;
    storageBridgeMocks.clearSyncedStorageForReset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseNativeDeletion = resolve;
        }),
    );

    let settled = false;
    const resetPromise = clearRendererStorageForReset().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseNativeDeletion?.();
    await resetPromise;
    expect(settled).toBe(true);
  });

  it("sweeps credentials written while native deletion is still draining", async () => {
    let releaseNativeDeletion: (() => void) | undefined;
    storageBridgeMocks.clearSyncedStorageForReset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseNativeDeletion = resolve;
        }),
    );

    const resetPromise = clearRendererStorageForReset();
    await vi.waitFor(() => {
      expect(releaseNativeDeletion).toBeTypeOf("function");
    });

    localStorage.setItem(ANTHROPIC_OAUTH_MARKER, "late-marker");
    localStorage.setItem(OPENAI_OAUTH_MARKER, "late-marker");
    sessionStorage.setItem(CLOUD_PAIR_SESSION_STORAGE_KEY, "late-pair-token");
    window.history.replaceState(null, "", "/settings?setup=oauth&late=1");
    client.setToken("late-client-token");
    releaseNativeDeletion?.();
    await resetPromise;

    expect(localStorage.getItem(ANTHROPIC_OAUTH_MARKER)).toBeNull();
    expect(localStorage.getItem(OPENAI_OAUTH_MARKER)).toBeNull();
    expect(sessionStorage.getItem(CLOUD_PAIR_SESSION_STORAGE_KEY)).toBeNull();
    expect(new URLSearchParams(window.location.search).get("setup")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("late")).toBe("1");
    expect(client.apiToken).toBeNull();
    expect(getBootConfig().apiToken).toBeUndefined();
  });

  it("rejects stale one-time-key and profile writers after reset completes", async () => {
    const staleGeneration = captureRendererCredentialWriteGeneration();

    await clearRendererStorageForReset();

    expect(() =>
      storeOneTimeAppApiKey("late-app", "late-api-key", staleGeneration),
    ).toThrow(RendererCredentialResetError);
    expect(() =>
      saveAgentProfileRegistry(
        {
          version: 1,
          activeProfileId: "late-profile",
          profiles: [],
        },
        staleGeneration,
      ),
    ).toThrow(RendererCredentialResetError);
    expect(consumeOneTimeAppApiKey("late-app")).toBeUndefined();
    expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBeNull();
  });

  it("still runs native cleanup when a browser-store operation fails", async () => {
    localStorage.setItem(STEWARD_REFRESH_TOKEN_KEY, "refresh-token");
    const originalRemoveItem = Storage.prototype.removeItem;
    let injectedFailure = false;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === STEWARD_REFRESH_TOKEN_KEY && !injectedFailure) {
        injectedFailure = true;
        throw new Error("injected localStorage removal failure");
      }
      originalRemoveItem.call(this, key);
    });

    await expect(clearRendererStorageForReset()).rejects.toBeInstanceOf(
      AggregateError,
    );

    expect(
      storageBridgeMocks.clearSyncedStorageForReset,
    ).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STEWARD_REFRESH_TOKEN_KEY)).toBeNull();
  });
});
