/**
 * Subscription-account selection tests use the real global bridge contract with
 * a deterministic fake pool. They cover first-call auth, per-runtime affinity,
 * serialized rotation, token refresh, least-privilege child environments, and
 * provider failover without launching a real model process.
 */

import {
  CODING_AGENT_SELECTOR_BRIDGE_SYMBOL,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModels, ClaudeSdkSession, CodexSdkSession } from "../index";
import {
  buildAmbientSubprocessEnv,
  buildRotatedSubprocessEnv,
  isSubscriptionLimitError,
  type RotationAccountSelection,
  resetRotationStateForTests,
  rotationAgentTypeForBackend,
  rotationEnabled,
  withAccountRotation,
} from "../src/account-rotation";
import { ProviderApiError } from "../src/provider-errors";

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;

interface FakeBridge {
  select: ReturnType<typeof vi.fn>;
  markRateLimited: ReturnType<typeof vi.fn>;
  recordUsage: ReturnType<typeof vi.fn>;
}

function installFakeBridge(selections: Array<RotationAccountSelection | null>): FakeBridge {
  let i = 0;
  const bridge: FakeBridge = {
    select: vi.fn(async () => {
      const next = i < selections.length ? selections[i] : null;
      i += 1;
      return next;
    }),
    markRateLimited: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
  (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
  return bridge;
}

function uninstallBridge(): void {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
}

function account(id: string): RotationAccountSelection {
  return {
    providerId: "anthropic-subscription",
    accountId: id,
    label: id,
    source: "oauth",
    strategy: "least-used",
    envPatch: { CLAUDE_CODE_OAUTH_TOKEN: `tok-${id}` },
  };
}

function codexAccount(id: string): RotationAccountSelection {
  return {
    providerId: "openai-codex",
    accountId: id,
    label: id,
    source: "oauth",
    strategy: "least-used",
    envPatch: { CODEX_HOME: `/selected/codex/${id}` },
  };
}

type TextModelHandler = (runtime: IAgentRuntime, params: GenerateTextParams) => Promise<string>;

function claudeSdkRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: (key: string) => (key === "ELIZA_CHAT_VIA_CLI" ? "claude-sdk" : undefined),
  } as IAgentRuntime;
}

function codexSdkRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: (key: string) => (key === "ELIZA_CHAT_VIA_CLI" ? "codex-sdk" : undefined),
  } as IAgentRuntime;
}

function requiredModelHandler(models: Record<string, TextModelHandler>, modelType: string) {
  const handler = models[modelType];
  if (!handler) throw new Error(`missing test model handler ${modelType}`);
  return handler;
}

const enabledGetter = () => undefined;

afterEach(() => {
  delete process.env.ELIZA_PLANNER_NATIVE_TOOLS;
  uninstallBridge();
  resetRotationStateForTests();
  vi.restoreAllMocks();
});

describe("isSubscriptionLimitError", () => {
  it("classifies the session handler's own limit throw", () => {
    expect(
      isSubscriptionLimitError(
        new Error(
          "[cli-inference:sdk] subscription rate limit reached: You've hit your session limit"
        )
      )
    ).toBe(true);
  });

  it("classifies 429 / 529 status envelopes", () => {
    expect(
      isSubscriptionLimitError(new ProviderApiError("upstream API Error: 429", { statusCode: 429 }))
    ).toBe(true);
    expect(
      isSubscriptionLimitError(new ProviderApiError("upstream API Error: 529", { statusCode: 529 }))
    ).toBe(true);
    expect(isSubscriptionLimitError(new Error("API Error: 429 rate limited"))).toBe(true);
  });

  it("classifies provider quota / rate-limit vocabulary", () => {
    expect(isSubscriptionLimitError(new Error("usage limit reached"))).toBe(true);
    expect(isSubscriptionLimitError(new Error("quota exhausted for this key"))).toBe(true);
    expect(isSubscriptionLimitError(new Error("too many requests"))).toBe(true);
  });

  it("classifies OpenAI's classic quota envelope (inverted word order, no 429 literal)", () => {
    // The real envelope: message text alone, no statusCode on the thrown error —
    // the exact shape a codex-sdk turn surfaces. Must rotate, not tier-failover.
    expect(
      isSubscriptionLimitError(
        new Error(
          "You exceeded your current quota, please check your plan and billing details. " +
            "For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors."
        )
      )
    ).toBe(true);
    // Truncated variants: either envelope half alone still classifies.
    expect(isSubscriptionLimitError(new Error("You exceeded your current quota"))).toBe(true);
    expect(isSubscriptionLimitError(new Error("please check your plan and billing details"))).toBe(
      true
    );
    // The machine-readable error code from the JSON envelope body.
    expect(
      isSubscriptionLimitError(
        new Error('{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}')
      )
    ).toBe(true);
  });

  it("does NOT classify prose that merely talks about quotas / billing", () => {
    expect(
      isSubscriptionLimitError(
        new Error("the user asked how quotas work and whether billing resets monthly")
      )
    ).toBe(false);
    expect(
      isSubscriptionLimitError(new Error("your quota looks fine; billing details are unchanged"))
    ).toBe(false);
  });

  it("does NOT classify non-limit errors (would burn a healthy account)", () => {
    expect(
      isSubscriptionLimitError(new Error("[cli-inference:sdk] empty completion (subtype=success)"))
    ).toBe(false);
    expect(
      isSubscriptionLimitError(
        new ProviderApiError("API Error: 400 messages: text content blocks must be non-empty", {
          statusCode: 400,
        })
      )
    ).toBe(false);
    expect(isSubscriptionLimitError(new Error("401 unauthorized"))).toBe(false);
    expect(isSubscriptionLimitError(new Error("route: model emitted no decision"))).toBe(false);
  });
});

describe("rotationAgentTypeForBackend", () => {
  it("maps only the SDK backends to a rotation agent type", () => {
    expect(rotationAgentTypeForBackend("claude-sdk")).toBe("claude");
    expect(rotationAgentTypeForBackend("codex-sdk")).toBe("codex");
    // Cold CLIs read the single on-disk login — out of scope (Gap B / CLI shim).
    expect(rotationAgentTypeForBackend("claude")).toBeNull();
    expect(rotationAgentTypeForBackend("codex")).toBeNull();
  });
});

describe("rotationEnabled", () => {
  it("defaults ON and honors the opt-out flag", () => {
    expect(rotationEnabled(() => undefined)).toBe(true);
    expect(rotationEnabled(() => "1")).toBe(true);
    for (const off of ["0", "false", "no", "off", "OFF", " Off "]) {
      expect(rotationEnabled(() => off)).toBe(false);
    }
  });
});

describe("buildRotatedSubprocessEnv", () => {
  it("keeps ambient process env intact while selected account auth wins in subprocess env", () => {
    const saved = {
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CODEX_HOME: process.env.CODEX_HOME,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
    };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-claude-token";
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
    process.env.CODEX_HOME = "/ambient/codex";
    process.env.OPENAI_API_KEY = "ambient-openai-key";
    process.env.GITHUB_TOKEN = "ambient-github-token";
    process.env.AWS_SECRET_ACCESS_KEY = "ambient-aws-secret";
    process.env.DATABASE_URL = "postgres://ambient-secret";

    try {
      const claudeEnv = buildRotatedSubprocessEnv("claude", {
        CLAUDE_CODE_OAUTH_TOKEN: "selected-claude-token",
      });
      expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("selected-claude-token");
      expect(claudeEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(claudeEnv.PATH).toBe(process.env.PATH);
      expect(claudeEnv.OPENAI_API_KEY).toBeUndefined();
      expect(claudeEnv.CODEX_HOME).toBeUndefined();
      expect(claudeEnv.GITHUB_TOKEN).toBeUndefined();
      expect(claudeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(claudeEnv.DATABASE_URL).toBeUndefined();

      const codexEnv = buildRotatedSubprocessEnv("codex", { CODEX_HOME: "/selected/codex" });
      expect(codexEnv.CODEX_HOME).toBe("/selected/codex");
      expect(codexEnv.OPENAI_API_KEY).toBeUndefined();
      expect(codexEnv.PATH).toBe(process.env.PATH);
      expect(codexEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(codexEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(codexEnv.GITHUB_TOKEN).toBeUndefined();
      expect(codexEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(codexEnv.DATABASE_URL).toBeUndefined();

      const ambientClaude = buildAmbientSubprocessEnv("claude");
      expect(ambientClaude.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-claude-token");
      expect(ambientClaude.ANTHROPIC_API_KEY).toBe("ambient-anthropic-key");
      expect(ambientClaude.OPENAI_API_KEY).toBeUndefined();
      expect(ambientClaude.GITHUB_TOKEN).toBeUndefined();

      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-claude-token");
      expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-anthropic-key");
      expect(process.env.CODEX_HOME).toBe("/ambient/codex");
      expect(process.env.OPENAI_API_KEY).toBe("ambient-openai-key");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects empty or cross-backend selected auth patches", () => {
    expect(() => buildRotatedSubprocessEnv("claude", {})).toThrow(/has no auth env/);
    expect(() => buildRotatedSubprocessEnv("claude", { CODEX_HOME: "/wrong/provider" })).toThrow(
      /unexpected claude auth env key/
    );
    expect(() => buildRotatedSubprocessEnv("codex", { OPENAI_API_KEY: "  " })).toThrow(
      /empty OPENAI_API_KEY/
    );
  });
});

describe("withAccountRotation", () => {
  const ctx = (overrides: Record<string, unknown> = {}) => ({
    backend: "claude-sdk",
    getValue: enabledGetter,
    scope: {},
    ...overrides,
  });

  it("uses a pooled account for the first isolated SDK auth — no ambient token needed", async () => {
    // THE app-connect regression: a machine with NO ambient CLI login but a
    // pooled (app-connected) subscription must serve the very first turn from
    // the pool, not fail / sit stored-but-unused until a limit error.
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async (env?: Record<string, string | undefined>) => {
      expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
      return "first-turn-on-pooled-account";
    });
    const c = ctx();
    try {
      await expect(withAccountRotation(attempt, c as never)).resolves.toBe(
        "first-turn-on-pooled-account"
      );
      expect(attempt).toHaveBeenCalledTimes(1);
      // Pool consulted BEFORE the first attempt, without an exclude list.
      expect(bridge.select).toHaveBeenCalledTimes(1);
      expect(bridge.select.mock.calls[0][1]?.exclude).toBeUndefined();
      expect(bridge.select.mock.invocationCallOrder[0]).toBeLessThan(
        attempt.mock.invocationCallOrder[0]
      );
      // Usage recorded against the initially-selected account on success.
      expect(bridge.recordUsage).toHaveBeenCalledWith("anthropic-subscription", "b", { ok: true });
      // The pooled token never leaks into the parent process env.
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    }
  });

  it("reports usage-accounting failures without failing successful inference", async () => {
    const bridge = installFakeBridge([account("b")]);
    bridge.recordUsage.mockRejectedValueOnce(new Error("usage store unavailable"));
    const reportError = vi.fn();

    await expect(
      withAccountRotation(async () => "answer", ctx({ scope: { reportError } }) as never)
    ).resolves.toBe("answer");
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    expect(reportError).toHaveBeenCalledWith(
      "cli-inference.account-rotation",
      expect.any(Error),
      expect.objectContaining({ operation: "record-usage" })
    );
  });

  it("contains a runtime reporter that violates the no-throw diagnostic contract", async () => {
    const bridge = installFakeBridge([account("b")]);
    bridge.recordUsage.mockRejectedValueOnce(new Error("usage store unavailable"));
    const reportError = vi.fn(() => {
      throw new Error("broken reporter");
    });
    const warn = vi.spyOn(logger, "warn");

    await expect(
      withAccountRotation(async () => "answer", ctx({ scope: { reportError } }) as never)
    ).resolves.toBe("answer");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "report-error-failed" }),
        expect.any(String)
      )
    );
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("falls back to the ambient credential when the pool is empty (select → null)", async () => {
    const bridge = installFakeBridge([null]);
    const attempt = vi.fn(async (env?: Record<string, string | undefined>) => {
      expect(env).toBeDefined();
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env?.GITHUB_TOKEN).toBeUndefined();
      return "ambient-answer";
    });
    const c = ctx();
    await expect(withAccountRotation(attempt, c as never)).resolves.toBe("ambient-answer");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select).toHaveBeenCalledTimes(1);
  });

  it("falls back to the ambient credential when the initial pool selection throws", async () => {
    const bridge = installFakeBridge([]);
    bridge.select.mockRejectedValueOnce(new Error("pool store unavailable"));
    const attempt = vi.fn(async (env?: Record<string, string | undefined>) => {
      expect(env).toBeDefined();
      expect(env?.PATH).toBe(process.env.PATH);
      return "ambient-answer";
    });
    await expect(withAccountRotation(attempt, ctx() as never)).resolves.toBe("ambient-answer");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("rotates on a subscription-limit error then succeeds on the next account", async () => {
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-token";
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    const bridge = installFakeBridge([account("b"), account("c")]);
    let calls = 0;
    const seenEnv: Array<Record<string, string | undefined> | undefined> = [];
    const attempt = vi.fn(async (env?: Record<string, string | undefined>) => {
      seenEnv.push(env);
      calls += 1;
      if (calls === 1) throw new Error("subscription rate limit reached: session limit");
      return "answer-on-account-c";
    });
    const c = ctx();
    try {
      await expect(withAccountRotation(attempt, c as never)).resolves.toBe("answer-on-account-c");
      expect(attempt).toHaveBeenCalledTimes(2);
      // First attempt already runs on the pool-selected account b (pool-first),
      // with the ambient token/key stripped from the subprocess env.
      expect(seenEnv[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
      expect(seenEnv[0]?.ANTHROPIC_API_KEY).toBeUndefined();
      // b limits → rotate to c.
      expect(seenEnv[1]?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-c");
      expect(seenEnv[1]?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seenEnv[1]?.PATH).toBe(process.env.PATH);
      expect(bridge.select).toHaveBeenCalledTimes(2);
      // The limited account b was marked + excluded from the rotation select.
      expect(bridge.markRateLimited).toHaveBeenCalledWith(
        "anthropic-subscription",
        "b",
        expect.any(Number),
        expect.any(String)
      );
      expect(bridge.select.mock.calls[1][1].exclude).toContain("b");
      // Selected tokens are scoped to the subprocess env only.
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-token");
      expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-key");
      // Usage recorded against the account we rotated INTO on success.
      expect(bridge.recordUsage).toHaveBeenCalledWith("anthropic-subscription", "c", { ok: true });
    } finally {
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("reports rate-limit bookkeeping failures while continuing account rotation", async () => {
    const bridge = installFakeBridge([account("b"), account("c")]);
    bridge.markRateLimited.mockRejectedValueOnce(new Error("health store unavailable"));
    const reportError = vi.fn();
    let attempts = 0;

    await expect(
      withAccountRotation(
        async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("429 too many requests");
          return "answer";
        },
        ctx({ scope: { reportError } }) as never
      )
    ).resolves.toBe("answer");
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        "cli-inference.account-rotation",
        expect.any(Error),
        expect.objectContaining({ operation: "mark-rate-limited" })
      )
    );
  });

  it("refreshes the exact selected account on later isolated calls", async () => {
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-token";
    const bridge = installFakeBridge([account("b"), account("b")]);
    const scope = {};
    try {
      await expect(
        withAccountRotation(
          async (env?: Record<string, string | undefined>) => {
            expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
            return "first-turn";
          },
          ctx({ sessionKey: "stable-session", scope }) as never
        )
      ).resolves.toBe("first-turn");

      const secondAttempt = vi.fn(async (env?: Record<string, string | undefined>) => {
        expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
        return "still-on-selected-account";
      });
      await expect(
        withAccountRotation(secondAttempt, ctx({ sessionKey: "stable-session", scope }) as never)
      ).resolves.toBe("still-on-selected-account");

      expect(secondAttempt).toHaveBeenCalledTimes(1);
      expect(bridge.select).toHaveBeenCalledTimes(2);
      expect(bridge.select.mock.calls[1][1]?.accountIds).toEqual(["b"]);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-token");
    } finally {
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    }
  });

  it("does not create implicit affinity when a direct caller omits the session key", async () => {
    const bridge = installFakeBridge([account("request-a"), account("request-b")]);
    const scope = {};

    await expect(withAccountRotation(async () => "first", ctx({ scope }) as never)).resolves.toBe(
      "first"
    );
    await expect(withAccountRotation(async () => "second", ctx({ scope }) as never)).resolves.toBe(
      "second"
    );

    const firstOptions = bridge.select.mock.calls[0]?.[1];
    const secondOptions = bridge.select.mock.calls[1]?.[1];
    expect(firstOptions?.sessionKey).toMatch(/^cli-inference:claude-sdk:request:/);
    expect(secondOptions?.sessionKey).toMatch(/^cli-inference:claude-sdk:request:/);
    expect(firstOptions?.sessionKey).not.toBe(secondOptions?.sessionKey);
    expect(secondOptions?.accountIds).toBeUndefined();
  });

  it("fails closed if the bridge violates an exact-account refresh pin", async () => {
    installFakeBridge([account("b"), account("c")]);
    const scope = {};
    const context = ctx({ sessionKey: "stable-session", scope }) as never;

    await expect(withAccountRotation(async () => "first", context)).resolves.toBe("first");
    await expect(withAccountRotation(async () => "second", context)).rejects.toThrow(
      /pinned claude account changed from b to c/
    );
  });

  it("isolates selected-account state between AgentRuntime scopes", async () => {
    const bridge = installFakeBridge([account("runtime-a"), account("runtime-b")]);
    const seen: string[] = [];
    const run = (scope: object) =>
      withAccountRotation(
        async (env) => {
          seen.push(env?.CLAUDE_CODE_OAUTH_TOKEN ?? "missing");
          return "ok";
        },
        ctx({ sessionKey: "same-model-mode", scope }) as never
      );

    await run({});
    await run({});

    expect(seen).toEqual(["tok-runtime-a", "tok-runtime-b"]);
    expect(bridge.select).toHaveBeenCalledTimes(2);
    expect(bridge.select.mock.calls[1][1]?.accountIds).toBeUndefined();
  });

  it("serializes selection and rotation for concurrent calls in one runtime scope", async () => {
    const bridge = installFakeBridge([account("b"), account("b")]);
    const scope = {};
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondAttemptEntered = false;

    const first = withAccountRotation(
      async () => {
        firstEntered?.();
        await firstGate;
        return "first";
      },
      ctx({ sessionKey: "serialized", scope }) as never
    );
    await firstStarted;
    const second = withAccountRotation(
      async () => {
        secondAttemptEntered = true;
        return "second";
      },
      ctx({ sessionKey: "serialized", scope }) as never
    );

    await Promise.resolve();
    expect(secondAttemptEntered).toBe(false);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(bridge.select.mock.calls[1][1]?.accountIds).toEqual(["b"]);
  });

  it("lets unrelated chat conversations select and execute independently", async () => {
    const bridge = installFakeBridge([account("chat-a"), account("chat-b")]);
    const runtime = claudeSdkRuntime();
    const handler = requiredModelHandler(
      buildModels({ ELIZA_CHAT_VIA_CLI: "claude-sdk" }) as Record<string, TextModelHandler>,
      "TEXT_LARGE"
    );
    const entered: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ClaudeSdkSession.prototype, "send").mockImplementation(async (body: string) => {
      entered.push(body);
      await gate;
      return body.includes("conversation-a") ? "answer-a" : "answer-b";
    });
    vi.spyOn(ClaudeSdkSession.prototype, "dispose").mockResolvedValue();

    const callA = handler(runtime, {
      prompt: "conversation-a",
      providerOptions: { eliza: { conversationId: "room-a" } },
    });
    const callB = handler(runtime, {
      prompt: "conversation-b",
      providerOptions: { eliza: { conversationId: "room-b" } },
    });

    let concurrencyFailure: unknown;
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(2));
    } catch (error) {
      concurrencyFailure = error;
    } finally {
      release?.();
    }
    const settled = await Promise.allSettled([callA, callB]);
    if (concurrencyFailure) throw concurrencyFailure;

    expect(settled).toEqual([
      { status: "fulfilled", value: "answer-a" },
      { status: "fulfilled", value: "answer-b" },
    ]);
    const firstSessionKey = bridge.select.mock.calls[0]?.[1]?.sessionKey;
    const secondSessionKey = bridge.select.mock.calls[1]?.[1]?.sessionKey;
    expect(firstSessionKey).toMatch(/^cli-inference:claude-sdk:conversation:[a-f0-9]{64}$/);
    expect(secondSessionKey).toMatch(/^cli-inference:claude-sdk:conversation:[a-f0-9]{64}$/);
    expect(firstSessionKey).not.toBe(secondSessionKey);
    expect(bridge.select.mock.calls[0]?.[1]?.accountIds).toBeUndefined();
    expect(bridge.select.mock.calls[1]?.[1]?.accountIds).toBeUndefined();
  });

  it("does not serialize unrelated Codex chats behind the model request shape", async () => {
    const bridge = installFakeBridge([codexAccount("chat-a"), codexAccount("chat-b")]);
    const runtime = codexSdkRuntime();
    const handler = requiredModelHandler(
      buildModels({ ELIZA_CHAT_VIA_CLI: "codex-sdk" }) as Record<string, TextModelHandler>,
      "TEXT_LARGE"
    );
    const entered: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(CodexSdkSession.prototype, "generate").mockImplementation(async (body: string) => {
      entered.push(body);
      await gate;
      return body.includes("conversation-a") ? "answer-a" : "answer-b";
    });

    const callA = handler(runtime, {
      prompt: "conversation-a",
      providerOptions: { eliza: { conversationId: "room-a" } },
    });
    const callB = handler(runtime, {
      prompt: "conversation-b",
      providerOptions: { eliza: { conversationId: "room-b" } },
    });

    let concurrencyFailure: unknown;
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(2));
    } catch (error) {
      concurrencyFailure = error;
    } finally {
      release?.();
    }
    const settled = await Promise.allSettled([callA, callB]);
    if (concurrencyFailure) throw concurrencyFailure;

    expect(settled).toEqual([
      { status: "fulfilled", value: "answer-a" },
      { status: "fulfilled", value: "answer-b" },
    ]);
    const firstSessionKey = bridge.select.mock.calls[0]?.[1]?.sessionKey;
    const secondSessionKey = bridge.select.mock.calls[1]?.[1]?.sessionKey;
    expect(firstSessionKey).toMatch(/^cli-inference:codex-sdk:conversation:[a-f0-9]{64}$/);
    expect(secondSessionKey).toMatch(/^cli-inference:codex-sdk:conversation:[a-f0-9]{64}$/);
    expect(firstSessionKey).not.toBe(secondSessionKey);
    expect(bridge.select.mock.calls[0]?.[1]?.accountIds).toBeUndefined();
    expect(bridge.select.mock.calls[1]?.[1]?.accountIds).toBeUndefined();
  });

  it("pins every SDK mode for one conversation to the same account", async () => {
    process.env.ELIZA_PLANNER_NATIVE_TOOLS = "0";
    const bridge = installFakeBridge([account("chat-a"), account("chat-a")]);
    const runtime = claudeSdkRuntime();
    const models = buildModels({ ELIZA_CHAT_VIA_CLI: "claude-sdk" }) as Record<
      string,
      TextModelHandler
    >;
    const textHandler = requiredModelHandler(models, "TEXT_LARGE");
    const plannerHandler = requiredModelHandler(models, "ACTION_PLANNER");
    vi.spyOn(ClaudeSdkSession.prototype, "send")
      .mockResolvedValueOnce("text-answer")
      .mockResolvedValueOnce('{"action":"NONE","params":{}}');
    vi.spyOn(ClaudeSdkSession.prototype, "dispose").mockResolvedValue();
    const providerOptions = { eliza: { conversationId: "room-stable" } };

    await expect(
      textHandler(runtime, {
        system: "text completion system",
        prompt: "first turn",
        providerOptions,
      })
    ).resolves.toBe("text-answer");
    await expect(
      plannerHandler(runtime, {
        system: "entirely different planner system",
        prompt: "choose an action",
        providerOptions,
      })
    ).resolves.toContain('"action":"NONE"');

    expect(bridge.select).toHaveBeenCalledTimes(2);
    const firstOptions = bridge.select.mock.calls[0]?.[1];
    const secondOptions = bridge.select.mock.calls[1]?.[1];
    expect(firstOptions?.sessionKey).toBe(secondOptions?.sessionKey);
    expect(secondOptions?.accountIds).toEqual(["chat-a"]);
  });

  it("uses a unique pool session for every model call without core affinity", async () => {
    const bridge = installFakeBridge([account("anonymous-a"), account("anonymous-b")]);
    const runtime = claudeSdkRuntime();
    const handler = requiredModelHandler(
      buildModels({ ELIZA_CHAT_VIA_CLI: "claude-sdk" }) as Record<string, TextModelHandler>,
      "TEXT_LARGE"
    );
    vi.spyOn(ClaudeSdkSession.prototype, "send")
      .mockResolvedValueOnce("anonymous-a")
      .mockResolvedValueOnce("anonymous-b");
    vi.spyOn(ClaudeSdkSession.prototype, "dispose").mockResolvedValue();

    await expect(handler(runtime, { system: "same", prompt: "same" })).resolves.toBe("anonymous-a");
    await expect(handler(runtime, { system: "same", prompt: "same" })).resolves.toBe("anonymous-b");

    const firstOptions = bridge.select.mock.calls[0]?.[1];
    const secondOptions = bridge.select.mock.calls[1]?.[1];
    expect(firstOptions?.sessionKey).toMatch(/^cli-inference:claude-sdk:request:/);
    expect(secondOptions?.sessionKey).toMatch(/^cli-inference:claude-sdk:request:/);
    expect(firstOptions?.sessionKey).not.toBe(secondOptions?.sessionKey);
    expect(secondOptions?.accountIds).toBeUndefined();
  });

  it("rotates on OpenAI's classic quota envelope (the pre-fix silent tier-failover)", async () => {
    const bridge = installFakeBridge([codexAccount("b"), codexAccount("c")]);
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          "You exceeded your current quota, please check your plan and billing details."
        );
      }
      return "answer-on-account-c";
    });
    const c = ctx({ backend: "codex-sdk" });
    await expect(withAccountRotation(attempt, c as never)).resolves.toBe("answer-on-account-c");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(bridge.select).toHaveBeenCalledTimes(2);
  });

  it("does NOT rotate on a non-limit error — rethrows immediately to failover", async () => {
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async () => {
      throw new Error("[cli-inference:sdk] empty completion (subtype=success)");
    });
    const c = ctx();
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow("empty completion");
    expect(attempt).toHaveBeenCalledTimes(1);
    // Only the pool-first initial selection ran — no rotation select.
    expect(bridge.select).toHaveBeenCalledTimes(1);
    expect(bridge.markRateLimited).not.toHaveBeenCalled();
  });

  it("excludes already-tried accounts and rotates through several before succeeding", async () => {
    const bridge = installFakeBridge([account("b"), account("c"), account("d")]);
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("429 too many requests");
      return "answer-on-account-d";
    });
    await expect(withAccountRotation(attempt, ctx() as never)).resolves.toBe("answer-on-account-d");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(bridge.select).toHaveBeenCalledTimes(3);
    // Each rotation select excludes every account already tried.
    expect(bridge.select.mock.calls[1][1].exclude).toEqual(["b"]);
    expect(bridge.select.mock.calls[2][1].exclude).toEqual(["b", "c"]);
  });

  it("does not select and retain an untried account after the rotation budget", async () => {
    const bridge = installFakeBridge([account("b"), account("c"), account("d")]);
    const attempt = vi.fn(async () => {
      throw new Error("429 too many requests");
    });

    await expect(withAccountRotation(attempt, ctx() as never, 1)).rejects.toThrow(
      "429 too many requests"
    );
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(bridge.select).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the selector returns an explicitly excluded account", async () => {
    const bridge = installFakeBridge([account("b"), account("b")]);
    const attempt = vi.fn(async () => {
      throw new Error("429 too many requests");
    });

    await expect(withAccountRotation(attempt, ctx() as never)).rejects.toThrow(
      /selector returned an excluded account/
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select.mock.calls[1][1].exclude).toEqual(["b"]);
  });

  it("falls through to provider failover (rethrows) when the pool is exhausted", async () => {
    const bridge = installFakeBridge([account("b"), null]);
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    // Pool-first start on b; b limits → select returns null → rethrow.
    await expect(withAccountRotation(attempt, ctx() as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(bridge.select).toHaveBeenCalledTimes(2);
    // The limited account b was marked rate-limited before the exhausted select.
    expect(bridge.markRateLimited).toHaveBeenCalledWith(
      "anthropic-subscription",
      "b",
      expect.any(Number),
      expect.any(String)
    );
  });

  it("single-account no-op: no bridge installed → single un-wrapped attempt, throw to failover", async () => {
    uninstallBridge();
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    const c = ctx();
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not rotate when disabled via the opt-out flag", async () => {
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    const c = ctx({ getValue: () => "0" });
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it("non-rotatable backend (cold CLI) is a pass-through no-op", async () => {
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    const c = ctx({ backend: "claude" });
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select).not.toHaveBeenCalled();
  });
});
