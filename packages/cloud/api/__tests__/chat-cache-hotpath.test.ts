/**
 * Drives the Worker `/v1/chat` route through cached auth and admission while
 * database-backed compatibility seams are armed to fail if touched.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const aiActual = require("ai") as Record<string, unknown>;
const languageModelActual = await import("@/lib/providers/language-model");

const ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000dd";
const RESERVATION = {
  reservedAmount: 0.02,
  reservationTransactionId: "reservation-a",
  reconcile: mock(async () => undefined),
};

let capturedStreamConfig: Record<string, unknown> | undefined;
const callOrder: string[] = [];
const streamText = mock((config: Record<string, unknown>) => {
  callOrder.push("provider");
  capturedStreamConfig = config;
  return {
    toUIMessageStreamResponse: () => new Response("stream-started"),
  };
});

mock.module("ai", () => ({
  ...aiActual,
  convertToModelMessages: mock(async (messages: unknown) => messages),
  streamText,
}));

const getCurrentUser = mock(async () => {
  throw new Error("database auth must not run on the Worker hot path");
});
mock.module("@/lib/auth/workers-hono-auth", () => ({ getCurrentUser }));

const getAnonymousUser = mock(async () => {
  throw new Error("anonymous database auth must not run for an org caller");
});
const reserveAnonymousMessageSlot = mock(async () => {
  throw new Error("anonymous database quota must not run for an org caller");
});
mock.module("@/lib/auth-anonymous", () => ({
  getAnonymousUser,
  reserveAnonymousMessageSlot,
}));

let anonymousResolutionImpl: () => Promise<unknown> = async () => {
  throw new Error("anonymous gate must not run for an org caller");
};
const resolveAnonymousChatContext = mock(() => anonymousResolutionImpl());
const reserveAnonymousChatSlot = mock(async () => ({
  kind: "admitted" as const,
  lease: {
    credential: {
      sessionToken: "anonymous-token",
      context: {
        sessionId: "anonymous-session",
        userId: "anonymous-user",
        messageCount: 0,
        messagesLimit: 10,
      },
    },
    requestId: "anonymous-request",
  },
  remaining: 9,
  limit: 10,
}));
const refundAnonymousChatSlot = mock(async () => undefined);
const commitAnonymousChatSlot = mock(async () => undefined);
const refreshAnonymousChatModeration = mock(async () => undefined);
mock.module("@/lib/services/anonymous-chat-admission", () => ({
  resolveAnonymousChatContext,
  reserveAnonymousChatSlot,
  refundAnonymousChatSlot,
  commitAnonymousChatSlot,
  refreshAnonymousChatModeration,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/models", () => ({
  resolveModel: () => ({ modelId: "openai/gpt-oss-120b", provider: "openai" }),
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getAiProviderConfigurationError: () => "AI services are not configured",
  getLanguageModel: () => ({}) as never,
  hasLanguageModelProviderConfigured: () => true,
  resolveAiProviderSource: () => "openai",
}));

const shouldBlockUser = mock(async () => {
  throw new Error("database moderation must not run after cached auth");
});
mock.module("@/lib/services/content-moderation", () => ({
  contentModerationService: {
    moderateInBackground: mock(async () => undefined),
    shouldBlockUser,
  },
}));

let authResolutionImpl: () => Promise<unknown> = async () => ({
  kind: "authorized" as const,
  ctx: {
    userId: USER,
    orgId: ORG,
    apiKeyId: "api-key-a",
  },
});
const resolveInferenceAuthContext = mock(() => authResolutionImpl());
mock.module("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));

const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const admitOrganizationInference = mock(
  async (_params: Record<string, unknown>) => {
    callOrder.push("admission");
    return {
      mode: "deferred_reservation",
      settle,
      settleUnknown,
      reservation: RESERVATION,
    };
  },
);
mock.module("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference,
}));

let releaseBilling: (() => void) | undefined;
const billUsage = mock(
  async (
    _context: Record<string, unknown>,
    _usage: Record<string, unknown>,
    _reservation: unknown,
  ) => {
    await new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });
    return {
      inputCost: 0.001,
      outputCost: 0.002,
      totalCost: 0.003,
    };
  },
);
mock.module("@/lib/services/ai-billing", () => ({ billUsage }));

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    createAnonymousReservation: mock(() => ({
      reservedAmount: 0,
      reconcile: async () => undefined,
    })),
  },
  DEFAULT_OUTPUT_TOKENS: 500,
  InsufficientCreditsError: class extends Error {},
}));

mock.module("@/lib/services/usage", () => ({
  usageService: { create: mock(async () => ({ id: "usage-a" })) },
}));
mock.module("@/lib/services/generations", () => ({
  generationsService: { create: mock(async () => undefined) },
}));
mock.module("@/lib/services/conversations", () => ({
  conversationsService: {
    addMessageWithSequence: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    addTokenUsage: mock(async () => undefined),
    refundMessageSlot: mock(async () => undefined),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock() },
}));

mock.module("@/lib/providers/anthropic-thinking", () => ({
  resolveAnthropicThinkingBudgetTokens: () => null,
  mergeAnthropicCotProviderOptions: () => ({}),
}));

const { default: chatRoute } = await import("../v1/chat/route");

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
});

beforeEach(() => {
  capturedStreamConfig = undefined;
  releaseBilling = undefined;
  callOrder.length = 0;
  streamText.mockClear();
  billUsage.mockClear();
  settle.mockClear();
  admitOrganizationInference.mockClear();
  getCurrentUser.mockClear();
  getAnonymousUser.mockClear();
  reserveAnonymousMessageSlot.mockClear();
  shouldBlockUser.mockClear();
  resolveInferenceAuthContext.mockClear();
  resolveAnonymousChatContext.mockClear();
  reserveAnonymousChatSlot.mockClear();
  refundAnonymousChatSlot.mockClear();
  commitAnonymousChatSlot.mockClear();
  authResolutionImpl = async () => ({
    kind: "authorized" as const,
    ctx: {
      userId: USER,
      orgId: ORG,
      apiKeyId: "api-key-a",
    },
  });
  anonymousResolutionImpl = async () => {
    throw new Error("anonymous gate must not run for an org caller");
  };
});

describe("/v1/chat Worker cache hot path", () => {
  test("dispatches only after cached admission and defers reservation-aware billing", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer eliza_cached",
          "X-Affiliate-Code": "affiliate-a",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(["admission", "provider"]);
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getAnonymousUser).not.toHaveBeenCalled();
    expect(reserveAnonymousMessageSlot).not.toHaveBeenCalled();
    expect(shouldBlockUser).not.toHaveBeenCalled();
    expect(resolveInferenceAuthContext).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ cacheOnly: true, executionCtx }),
    );
    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateCode: "affiliate-a",
        executionCtx,
        estimatedOutputTokens: 500,
      }),
    );

    const onFinish = capturedStreamConfig?.onFinish as
      | ((result: {
          text: string;
          usage: { inputTokens: number; outputTokens: number };
        }) => Promise<void>)
      | undefined;
    await onFinish?.({
      text: "hello back",
      usage: { inputTokens: 3, outputTokens: 4 },
    });

    expect(waitUntilTasks).toHaveLength(2);
    expect(settle).not.toHaveBeenCalled();
    releaseBilling?.();
    await Promise.all(waitUntilTasks);
    expect(billUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        affiliateCode: "affiliate-a",
      }),
      { inputTokens: 3, outputTokens: 4 },
      RESERVATION,
    );
    expect(settle).toHaveBeenCalledWith(0.003);
  });

  test("uses the anonymous Durable Object lease without database auth or quota reads", async () => {
    authResolutionImpl = async () => ({ kind: "slow_path" as const });
    anonymousResolutionImpl = async () => ({
      kind: "ready" as const,
      blocked: false,
      credential: {
        sessionToken: "anonymous-token",
        context: {
          sessionId: "anonymous-session",
          userId: "anonymous-user",
          messageCount: 0,
          messagesLimit: 10,
        },
      },
    });
    const waitUntilTasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "eliza-anon-session=anonymous-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );

    expect(response.status).toBe(200);
    expect(resolveAnonymousChatContext).toHaveBeenCalled();
    expect(reserveAnonymousChatSlot).toHaveBeenCalled();
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getAnonymousUser).not.toHaveBeenCalled();
    expect(reserveAnonymousMessageSlot).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["provider"]);
    expect(waitUntilTasks).toHaveLength(1);
    await Promise.all(waitUntilTasks);
  });
});
