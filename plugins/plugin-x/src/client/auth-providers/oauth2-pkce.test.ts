/** OAuth teardown races are exercised with delayed token endpoints and stores so reset cannot be followed by a late credential write. */
import { AgentRuntime } from "@elizaos/core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitterClientState } from "../../types";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import type { StoredOAuth2Tokens, TokenStore } from "./token-store";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const activeRuntimes = new Set<AgentRuntime>();

function runtime(): AgentRuntime {
  const instance = new AgentRuntime({ logLevel: "fatal" });
  activeRuntimes.add(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(
    [...activeRuntimes].map((instance) => instance.stop({ fast: true })),
  );
  activeRuntimes.clear();
});

const state: TwitterClientState = {
  accountId: "primary",
  TWITTER_AUTH_MODE: "oauth",
  TWITTER_CLIENT_ID: "client-id",
  TWITTER_REDIRECT_URI: "http://127.0.0.1:9876/callback",
};

function tokenResponse(tokens: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}): Response {
  return new Response(JSON.stringify(tokens), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("OAuth2PKCEAuthProvider teardown", () => {
  it("aborts a delayed refresh and rejects its result before token persistence", async () => {
    const response = deferred<Response>();
    const fetchStarted = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const store: TokenStore = {
      load: vi.fn(async () => ({
        access_token: "expired-access",
        refresh_token: "refresh-token",
        expires_at: 0,
      })),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      fetchStarted.resolve();
      return await response.promise;
    }) as typeof fetch;
    const provider = new OAuth2PKCEAuthProvider(
      runtime(),
      state,
      store,
      fetchImpl,
    );

    const access = provider.getAccessToken();
    await fetchStarted.promise;
    const disposed = provider.dispose();
    expect(requestSignal?.aborted).toBe(true);

    response.resolve(
      tokenResponse({
        access_token: "late-access",
        refresh_token: "late-refresh",
        expires_in: 3600,
      }),
    );

    await expect(access).rejects.toMatchObject({ name: "AbortError" });
    await disposed;
    expect(store.save).not.toHaveBeenCalled();
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("invalidates delayed interactive login before it can save tokens", async () => {
    const login = deferred<StoredOAuth2Tokens>();
    const loginStarted = deferred<void>();
    let loginSignal: AbortSignal | undefined;
    const store: TokenStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const provider = new OAuth2PKCEAuthProvider(
      runtime(),
      state,
      store,
      fetch,
      async (signal) => {
        loginSignal = signal;
        loginStarted.resolve();
        return await login.promise;
      },
    );

    const access = provider.getAccessToken();
    await loginStarted.promise;
    const disposed = provider.dispose();
    expect(loginSignal?.aborted).toBe(true);
    login.resolve({
      access_token: "late-interactive-access",
      refresh_token: "late-interactive-refresh",
      expires_at: Date.now() + 3_600_000,
    });

    await expect(access).rejects.toMatchObject({ name: "AbortError" });
    await disposed;
    expect(store.save).not.toHaveBeenCalled();
  });

  it("does not finish disposal while an already-started token save is pending", async () => {
    const save = deferred<void>();
    const saveStarted = deferred<void>();
    const store: TokenStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {
        saveStarted.resolve();
        await save.promise;
      }),
      clear: vi.fn(async () => undefined),
    };
    const provider = new OAuth2PKCEAuthProvider(
      runtime(),
      state,
      store,
      fetch,
      async () => ({
        access_token: "interactive-access",
        refresh_token: "interactive-refresh",
        expires_at: Date.now() + 3_600_000,
      }),
    );

    const access = provider.getAccessToken();
    await saveStarted.promise;
    let disposeSettled = false;
    const disposed = provider.dispose().then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    save.resolve();
    await expect(access).rejects.toMatchObject({ name: "AbortError" });
    await disposed;
    expect(store.save).toHaveBeenCalledTimes(1);
  });
});
