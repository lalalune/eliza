import { AgentRuntime, createCharacter } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFeedAuthState,
  type FeedConfig,
  persistFeedCredential,
  proxyFeedRequest,
} from "./feed-auth";
import feedPlugin from "./index";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function baseConfig(overrides: Partial<FeedConfig> = {}): FeedConfig {
  return {
    apiBaseUrl: "http://feed.test",
    agentId: "agent-1",
    agentSecret: "agent-secret-value-at-least-32-characters",
    stewardToken: undefined,
    runtime: null,
    ...overrides,
  };
}

function authHeader(init: RequestInit | undefined): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization;
}

type FeedCharacterSecrets = NonNullable<AgentRuntime["character"]["secrets"]>;
type FeedSettingsSecrets = NonNullable<
  NonNullable<AgentRuntime["character"]["settings"]>["secrets"]
>;

function createFeedRuntime(name: string): {
  runtime: AgentRuntime;
  characterSecrets: FeedCharacterSecrets;
  settingsSecrets: FeedSettingsSecrets;
} {
  const runtime = new AgentRuntime({
    character: createCharacter({
      name,
      settings: { secrets: {} },
      secrets: {},
    }),
    logLevel: "fatal",
  });
  const characterSecrets = runtime.character.secrets;
  const settingsSecrets = runtime.character.settings?.secrets;
  if (!characterSecrets || !settingsSecrets) {
    throw new Error("feed test runtime did not retain its credential stores");
  }
  return { runtime, characterSecrets, settingsSecrets };
}

afterEach(() => {
  clearFeedAuthState(null);
  vi.restoreAllMocks();
});

describe("proxyFeedRequest — Steward-first auto-login", () => {
  it("forwards the agent's Steward JWT as Bearer and skips /api/agents/auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const res = await proxyFeedRequest(
      baseConfig({ stewardToken: "steward-jwt" }),
      "GET",
      "/api/posts",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/posts");
    expect(authHeader(init)).toBe("Bearer steward-jwt");
    // No agent-session exchange happened.
    expect(
      fetchSpy.mock.calls.some((c) =>
        String(c[0]).includes("/api/agents/auth"),
      ),
    ).toBe(false);
    // Dead cookie removed.
    expect((init?.headers as Record<string, string>).Cookie).toBeUndefined();
  });

  it("falls back to the agent-session path when the Steward JWT is rejected (401)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const u = String(url);
        if (u.includes("/api/agents/auth")) {
          return new Response(
            JSON.stringify({
              sessionToken: "agent-session-token",
              expiresIn: 600,
            }),
            { status: 200 },
          );
        }
        // Proxied request: reject the steward token, accept the session token.
        if (authHeader(init) === "Bearer steward-bad") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

    const res = await proxyFeedRequest(
      baseConfig({ stewardToken: "steward-bad" }),
      "GET",
      "/api/posts",
    );

    expect(res.status).toBe(200);
    // The agent-session exchange was used as fallback.
    expect(
      fetchSpy.mock.calls.some((c) =>
        String(c[0]).includes("/api/agents/auth"),
      ),
    ).toBe(true);
    // Final proxied request carried the agent session token.
    const finalCall = fetchSpy.mock.calls.at(-1);
    expect(authHeader(finalCall?.[1])).toBe("Bearer agent-session-token");
  });

  it("plugin disposal clears cached sessions and every in-process mirror", async () => {
    const { runtime, characterSecrets, settingsSecrets } =
      createFeedRuntime("Feed disposal test");
    persistFeedCredential(
      runtime,
      "FEED_AGENT_SECRET",
      "generated-secret",
      true,
    );
    let authCalls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (String(url).includes("/api/agents/auth")) {
          authCalls += 1;
          return new Response(
            JSON.stringify({
              sessionToken: `agent-session-${authCalls}`,
              expiresIn: 600,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
    const config = baseConfig({ runtime });

    await proxyFeedRequest(config, "GET", "/api/posts");
    expect(authCalls).toBe(1);
    expect(process.env.FEED_AGENT_SESSION_TOKEN).toBe("agent-session-1");
    expect(characterSecrets.FEED_AGENT_SESSION_TOKEN).toBe("agent-session-1");

    await feedPlugin.dispose?.(runtime);

    expect(process.env.FEED_AGENT_SESSION_TOKEN).toBeUndefined();
    expect(process.env.FEED_AGENT_SESSION_EXPIRES_AT).toBeUndefined();
    expect(process.env.FEED_AGENT_SECRET).toBeUndefined();
    expect(characterSecrets.FEED_AGENT_SESSION_TOKEN).toBeUndefined();
    expect(characterSecrets.FEED_AGENT_SECRET).toBeUndefined();
    expect(settingsSecrets.FEED_AGENT_SESSION_TOKEN).toBeUndefined();
    expect(settingsSecrets.FEED_AGENT_SECRET).toBeUndefined();

    await proxyFeedRequest(config, "GET", "/api/posts");
    expect(authCalls).toBe(2);
    expect(fetchSpy).toHaveBeenCalled();
    clearFeedAuthState(runtime);
  });

  it("does not persist an authentication response that arrives after disposal", async () => {
    const { runtime, characterSecrets } = createFeedRuntime(
      "Feed late-auth test",
    );
    const response = deferred<Response>();
    const entered = deferred<void>();
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/api/agents/auth")) {
        entered.resolve(undefined);
        return response.promise;
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    });

    const request = proxyFeedRequest(
      baseConfig({ runtime }),
      "GET",
      "/api/posts",
    );
    await entered.promise;
    await feedPlugin.dispose?.(runtime);
    response.resolve(
      new Response(
        JSON.stringify({ sessionToken: "late-token", expiresIn: 600 }),
        { status: 200 },
      ),
    );

    await expect(request).rejects.toThrow(/cancelled by agent reset/);
    expect(process.env.FEED_AGENT_SESSION_TOKEN).toBeUndefined();
    expect(characterSecrets.FEED_AGENT_SESSION_TOKEN).toBeUndefined();
  });

  it("isolates runtime ownership and restores a launch credential baseline", () => {
    const original = process.env.FEED_AGENT_SESSION_TOKEN;
    process.env.FEED_AGENT_SESSION_TOKEN = "launch-token";
    const { runtime: first } = createFeedRuntime("Feed owner one");
    const { runtime: second } = createFeedRuntime("Feed owner two");
    try {
      persistFeedCredential(first, "FEED_AGENT_SESSION_TOKEN", "first", true);
      persistFeedCredential(second, "FEED_AGENT_SESSION_TOKEN", "second", true);

      clearFeedAuthState(first);
      expect(process.env.FEED_AGENT_SESSION_TOKEN).toBe("second");

      clearFeedAuthState(second);
      expect(process.env.FEED_AGENT_SESSION_TOKEN).toBe("launch-token");
    } finally {
      clearFeedAuthState(first);
      clearFeedAuthState(second);
      if (original === undefined) delete process.env.FEED_AGENT_SESSION_TOKEN;
      else process.env.FEED_AGENT_SESSION_TOKEN = original;
    }
  });
});
