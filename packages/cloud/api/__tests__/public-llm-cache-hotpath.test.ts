/**
 * Public A2A, MCP, and app-chat requests are exercised through their real
 * route handlers with cache/admission/provider seams. The harness proves cold
 * cache state fails before dispatch and warm state acknowledges the durable
 * lease immediately before the provider while settlement stays in waitUntil.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as aiActual from "ai";
import { Hono } from "hono";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as pricingActual from "@/lib/pricing";
import * as providersActual from "@/lib/providers";
import * as anthropicActual from "@/lib/providers/anthropic-thinking";
import * as languageModelActual from "@/lib/providers/language-model";
import * as agentMonetizationActual from "@/lib/services/agent-monetization";
import * as appAdmissionActual from "@/lib/services/app-inference-admission";
import * as appsActual from "@/lib/services/apps";
import * as charactersActual from "@/lib/services/characters/characters";
import * as authContextActual from "@/lib/services/inference-auth-context";
import * as organizationAdmissionActual from "@/lib/services/organization-inference-admission";

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";
const APP_ID = "00000000-0000-4000-8000-0000000000cc";
const AGENT_ID = "00000000-0000-4000-8000-0000000000dd";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000ee";

const dispatchEvents: string[] = [];
const pendingTasks: Promise<unknown>[] = [];

const proof = {
  v: 1 as const,
  organizationId: ORG_ID,
  organizationRevision: "1",
  userId: USER_ID,
  userRevision: "1",
  credential: {
    kind: "api_key" as const,
    id: API_KEY_ID,
    fingerprint: "a".repeat(64),
    revision: "1",
    expiresAt: null,
  },
};

const authorized = {
  kind: "authorized" as const,
  ctx: {
    userId: USER_ID,
    orgId: ORG_ID,
    apiKeyId: API_KEY_ID,
    authorization: proof,
  },
};

const character = {
  id: AGENT_ID,
  name: "Cache Agent",
  user_id: "creator-user",
  organization_id: "creator-org",
  is_public: true,
  a2a_enabled: true,
  mcp_enabled: true,
  monetization_enabled: false,
  inference_markup_percentage: "0",
  system: null,
  bio: "Helpful.",
  category: null,
  tags: [],
  settings: {},
};

const appRecord = {
  id: APP_ID,
  name: "Cache App",
  organization_id: ORG_ID,
  monetization_enabled: false,
  platform_offset_amount: 0,
  purchase_share_percentage: 0,
  inference_markup_percentage: 0,
};

let authResolution: unknown = authorized;
let characterResolution: unknown = { kind: "ready", character };
let appResolution: unknown = { kind: "ready", app: appRecord };
let appScopeResolution: unknown = { kind: "ready", owningAppId: APP_ID };
let providerResponse: Response;

const resolveInferenceAuthContext = mock(
  async (_request: Request, _options: unknown) => authResolution,
);
mock.module("@/lib/services/inference-auth-context", () => ({
  ...authContextActual,
  resolveInferenceAuthContext,
}));

const enforceOrgRateLimit = mock(async () => null);
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

const getCharacterById = mock(async () => character);
const getCharacterByIdCacheOnly = mock(async () => characterResolution);
mock.module("@/lib/services/characters/characters", () => ({
  ...charactersActual,
  charactersService: {
    ...charactersActual.charactersService,
    getById: getCharacterById,
    getByIdCacheOnly: getCharacterByIdCacheOnly,
  },
}));

const getAppByIdCacheOnly = mock(async () => appResolution);
const getApiKeyOwningAppIdCacheOnly = mock(async () => appScopeResolution);
mock.module("@/lib/services/apps", () => ({
  ...appsActual,
  appsService: {
    ...appsActual.appsService,
    getByIdCacheOnly: getAppByIdCacheOnly,
    getApiKeyOwningAppIdCacheOnly,
  },
}));

const orgMarkProviderDispatched = mock(async () => {
  dispatchEvents.push("mark");
});
const orgSettle = mock(async () => ({
  adjustmentType: "none",
  reservedAmount: 0.01,
  actualCost: 0.001,
}));
const orgSettleUnknown = mock(async () => undefined);
const admitOrganizationInference = mock(async () => ({
  markProviderDispatched: orgMarkProviderDispatched,
  settle: orgSettle,
  settleUnknown: orgSettleUnknown,
}));
mock.module("@/lib/services/organization-inference-admission", () => ({
  ...organizationAdmissionActual,
  admitOrganizationInference,
}));

const appMarkProviderDispatched = mock(async () => {
  dispatchEvents.push("mark");
});
const appSettle = mock(async () => ({
  adjustmentType: "none",
  reservedAmount: 0.01,
  actualCost: 0.001,
}));
const appSettleUnknown = mock(async () => undefined);
const admitAppInferenceCacheOnly = mock(async () => ({
  markProviderDispatched: appMarkProviderDispatched,
  settle: appSettle,
  settleUnknown: appSettleUnknown,
}));
mock.module("@/lib/services/app-inference-admission", () => ({
  ...appAdmissionActual,
  admitAppInferenceCacheOnly,
}));

mock.module("@/lib/services/agent-monetization", () => ({
  ...agentMonetizationActual,
  recordAgentInferenceCreatorEarnings: mock(async () => undefined),
}));

const streamText = mock(async () => {
  dispatchEvents.push("provider");
  return {
    textStream: (async function* stream() {
      yield "hello";
    })(),
    usage: Promise.resolve({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    }),
  };
});
mock.module("ai", () => ({ ...aiActual, streamText }));

mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: mock(async () => ({ totalCost: 0.001 })),
  estimateTokens: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
  getProviderFromModel: () => "openai",
  normalizeModelName: (model: string) => model,
}));

mock.module("@/lib/providers/anthropic-thinking", () => ({
  ...anthropicActual,
  mergeAnthropicCotProviderOptions: () => ({}),
  parseThinkingBudgetFromCharacterSettings: () => null,
  resolveAnthropicThinkingBudgetTokens: () => null,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  canonicalizeCerebrasModelId: (model: string) => model,
  getLanguageModel: (model: string) => ({ model }),
  hasLanguageModelProviderConfigured: () => true,
  resolveAiProviderSource: () => "openai",
}));

const providerChatCompletions = mock(async () => {
  dispatchEvents.push("provider");
  return providerResponse;
});
mock.module("@/lib/providers", () => ({
  ...providersActual,
  getProviderForModelWithFallback: () => ({
    primary: { chatCompletions: providerChatCompletions },
    fallback: null,
  }),
  withProviderFallback: async (primary: () => Promise<Response>) => primary(),
}));

const [{ default: a2aRoute }, { default: mcpRoute }, { handlePOST }] =
  await Promise.all([
    import("../agents/[id]/a2a/route"),
    import("../agents/[id]/mcp/route"),
    import("../v1/apps/[id]/chat/route"),
  ]);

function executionContext() {
  return {
    waitUntil(promise: Promise<unknown>) {
      pendingTasks.push(promise);
    },
    passThroughOnException() {},
  };
}

async function drainPendingTasks(): Promise<void> {
  while (pendingTasks.length > 0) {
    await Promise.all(pendingTasks.splice(0));
  }
}

function agentRequest(protocol: "a2a" | "mcp"): Request {
  const body =
    protocol === "a2a"
      ? {
          jsonrpc: "2.0",
          method: "chat",
          params: {
            model: "gpt-5-mini",
            messages: [{ role: "user", content: "hello" }],
          },
          id: "rpc-1",
        }
      : {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "chat",
            arguments: { message: "hello", model: "gpt-5-mini" },
          },
          id: "rpc-1",
        };
  return new Request(`https://api.test/agents/${AGENT_ID}/${protocol}`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function callAgentRoute(protocol: "a2a" | "mcp"): Promise<Response> {
  const route = protocol === "a2a" ? a2aRoute : mcpRoute;
  const router = new Hono();
  router.route(`/agents/:id/${protocol}`, route);
  return router.fetch(agentRequest(protocol), {}, executionContext() as never);
}

function appRequest(): Request {
  return new Request(`https://api.test/v1/apps/${APP_ID}/chat`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
}

beforeEach(() => {
  authResolution = authorized;
  characterResolution = { kind: "ready", character };
  appResolution = { kind: "ready", app: appRecord };
  appScopeResolution = { kind: "ready", owningAppId: APP_ID };
  providerResponse = Response.json({
    choices: [{ message: { content: "hello" } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });
  dispatchEvents.length = 0;
  pendingTasks.length = 0;
  resolveInferenceAuthContext.mockClear();
  enforceOrgRateLimit.mockClear();
  getCharacterById.mockClear();
  getCharacterByIdCacheOnly.mockClear();
  getAppByIdCacheOnly.mockClear();
  getApiKeyOwningAppIdCacheOnly.mockClear();
  admitOrganizationInference.mockClear();
  admitAppInferenceCacheOnly.mockClear();
  orgMarkProviderDispatched.mockClear();
  appMarkProviderDispatched.mockClear();
  orgSettle.mockClear();
  appSettle.mockClear();
  orgSettleUnknown.mockClear();
  appSettleUnknown.mockClear();
  streamText.mockClear();
  providerChatCompletions.mockClear();
});

describe.each(["a2a", "mcp"] as const)(
  "%s cache-only provider boundary",
  (protocol) => {
    test("warm cache admits, marks, dispatches, and settles under waitUntil", async () => {
      const response = await callAgentRoute(protocol);
      expect(response.status).toBe(200);
      await drainPendingTasks();

      expect(resolveInferenceAuthContext).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ cacheOnly: true }),
      );
      expect(enforceOrgRateLimit).toHaveBeenCalledWith(
        ORG_ID,
        "standard",
        expect.objectContaining({ cacheOnly: true }),
      );
      expect(getCharacterByIdCacheOnly).toHaveBeenCalledTimes(1);
      expect(getCharacterById).not.toHaveBeenCalled();
      expect(dispatchEvents).toEqual(["mark", "provider"]);
      expect(admitOrganizationInference).toHaveBeenCalledWith(
        expect.objectContaining({ authorization: proof }),
      );
      expect(orgSettle).toHaveBeenCalledTimes(1);
    });

    test("cold authorization is retryable and reaches neither admission nor provider", async () => {
      authResolution = { kind: "warming", reason: "cache_miss" };

      const response = await callAgentRoute(protocol);

      expect(response.status).toBe(503);
      expect(admitOrganizationInference).not.toHaveBeenCalled();
      expect(streamText).not.toHaveBeenCalled();
      expect(dispatchEvents).toEqual([]);
    });

    test("cold agent policy is retryable and reaches neither admission nor provider", async () => {
      characterResolution = { kind: "warming", reason: "cache_miss" };

      const response = await callAgentRoute(protocol);

      expect(response.status).toBe(503);
      expect(admitOrganizationInference).not.toHaveBeenCalled();
      expect(streamText).not.toHaveBeenCalled();
      expect(dispatchEvents).toEqual([]);
    });
  },
);

describe("app chat cache-only provider boundary", () => {
  test("warm cache admits, marks, dispatches, and settles under waitUntil", async () => {
    const response = await handlePOST(
      appRequest(),
      { params: Promise.resolve({ id: APP_ID }) },
      executionContext(),
    );
    expect(response.status).toBe(200);
    await drainPendingTasks();

    expect(resolveInferenceAuthContext).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ cacheOnly: true }),
    );
    expect(enforceOrgRateLimit).toHaveBeenCalledWith(
      ORG_ID,
      "completions",
      expect.objectContaining({ cacheOnly: true }),
    );
    expect(getAppByIdCacheOnly).toHaveBeenCalledTimes(1);
    expect(getApiKeyOwningAppIdCacheOnly).toHaveBeenCalledTimes(1);
    expect(admitAppInferenceCacheOnly).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: proof }),
    );
    expect(dispatchEvents).toEqual(["mark", "provider"]);
    expect(appSettle).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["authorization", () => (authResolution = { kind: "warming" })],
    ["app policy", () => (appResolution = { kind: "warming" })],
    ["API-key scope", () => (appScopeResolution = { kind: "warming" })],
  ])(
    "%s cache miss is retryable and provider-free",
    async (_label, makeCold) => {
      makeCold();

      const response = await handlePOST(
        appRequest(),
        { params: Promise.resolve({ id: APP_ID }) },
        executionContext(),
      );

      expect(response.status).toBe(503);
      expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
      expect(providerChatCompletions).not.toHaveBeenCalled();
      expect(dispatchEvents).toEqual([]);
    },
  );

  test("dispatch acknowledgement failure prevents the provider and settles zero", async () => {
    appMarkProviderDispatched.mockRejectedValueOnce(
      new Error("durable acknowledgement unavailable"),
    );

    const response = await handlePOST(
      appRequest(),
      { params: Promise.resolve({ id: APP_ID }) },
      executionContext(),
    );
    await drainPendingTasks();

    expect(response.status).toBe(503);
    expect(providerChatCompletions).not.toHaveBeenCalled();
    expect(appSettle).toHaveBeenCalledWith(0);
  });
});
