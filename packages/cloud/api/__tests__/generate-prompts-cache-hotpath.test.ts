/**
 * Verifies prompt suggestions reach their provider only after cache-resolved
 * authorization and the real admission interface's dispatch acknowledgement.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as admissionActual from "@/lib/services/organization-inference-admission";

const aiActual = require("ai") as Record<string, unknown>;
const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext,
}));

const calculateCost = mock();
mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost,
  estimateTokens: () => 80,
  getProviderFromModel: () => "openai",
  normalizeModelName: (model: string) => model,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({ provider: "test" }) as never,
  isProviderConfigurationError: () => false,
  resolveAiProviderSource: () => "openai",
}));

const settle = mock();
const settleUnknown = mock();
const markProviderDispatched = mock();
const admitOrganizationInference = mock();
mock.module("@/lib/services/organization-inference-admission", () => ({
  ...admissionActual,
  admitOrganizationInference,
}));

const streamText = mock();
mock.module("ai", () => ({
  ...aiActual,
  streamText,
}));

const generatePromptsRoute = (await import("../v1/generate-prompts/route"))
  .default;

afterAll(() => {
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module(
    "@/lib/services/organization-inference-admission",
    () => admissionActual,
  );
  mock.module("ai", () => aiActual);
});

function executionContext() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        scheduled.push(Promise.resolve(promise));
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    scheduled,
  };
}

async function request(ctx: ExecutionContext): Promise<Response> {
  return await generatePromptsRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_cached",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seed: "stable" }),
    },
    {},
    ctx,
  );
}

beforeEach(() => {
  resolveInferenceAuthContext.mockReset();
  calculateCost.mockReset();
  settle.mockReset();
  settleUnknown.mockReset();
  markProviderDispatched.mockReset();
  admitOrganizationInference.mockReset();
  streamText.mockReset();

  resolveInferenceAuthContext.mockResolvedValue({
    kind: "authorized",
    source: "cache",
    ctx: {
      v: 2,
      cachedAt: Date.now(),
      userId: USER,
      orgId: ORG,
      apiKeyId: API_KEY_ID,
      authorization: {
        version: 1,
        organizationId: ORG,
        userId: USER,
        credentialId: API_KEY_ID,
      },
    },
  });
  calculateCost.mockResolvedValue({ totalCost: 0.002 });
  settle.mockResolvedValue(null);
  settleUnknown.mockResolvedValue(null);
  markProviderDispatched.mockResolvedValue(undefined);
  admitOrganizationInference.mockResolvedValue({
    mode: "durable_object_debit",
    settle,
    settleUnknown,
    markProviderDispatched,
  });
  streamText.mockReturnValue({
    toTextStreamResponse: () =>
      new Response('["Cache","Only","Prompt","Ideas"]', {
        headers: { "Content-Type": "text/plain" },
      }),
  });
});

describe("POST /api/v1/generate-prompts cache hot path", () => {
  test("dispatches only after the authorization-bearing DO admission acknowledgement", async () => {
    const order: string[] = [];
    markProviderDispatched.mockImplementation(async () => {
      order.push("dispatch-ack");
    });
    streamText.mockImplementation((options: unknown) => {
      order.push("provider");
      return {
        options,
        toTextStreamResponse: () => new Response("[]"),
      };
    });
    const { ctx } = executionContext();

    const response = await request(ctx);

    expect(response.status).toBe(200);
    expect(order).toEqual(["dispatch-ack", "provider"]);
    expect(resolveInferenceAuthContext).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ cacheOnly: true, executionCtx: ctx }),
    );
    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: API_KEY_ID,
        authorization: expect.objectContaining({
          organizationId: ORG,
          userId: USER,
          credentialId: API_KEY_ID,
        }),
        context: expect.objectContaining({
          organizationId: ORG,
          userId: USER,
          apiKeyId: API_KEY_ID,
          provider: "openai",
          billingSource: "openai",
        }),
        executionCtx: ctx,
      }),
    );
  });

  test("returns retryable unavailability on a cold auth cache without provider work", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({ kind: "warming" });
    const { ctx } = executionContext();

    const response = await request(ctx);

    expect(response.status).toBe(503);
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(markProviderDispatched).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("fails closed when the final dispatch acknowledgement is unavailable", async () => {
    markProviderDispatched.mockRejectedValueOnce(new Error("DO unavailable"));
    const { ctx, scheduled } = executionContext();

    const response = await request(ctx);

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(streamText).not.toHaveBeenCalled();
    await Promise.all(scheduled);
    expect(settle).toHaveBeenCalledWith(0);
  });

  test("returns the stream before exact-usage accounting and settles under waitUntil", async () => {
    let finish:
      | ((event: {
          usage: { inputTokens: number; outputTokens: number };
        }) => Promise<void>)
      | undefined;
    streamText.mockImplementation((options: { onFinish?: typeof finish }) => {
      finish = options.onFinish;
      return { toTextStreamResponse: () => new Response("[]") };
    });
    const { ctx, scheduled } = executionContext();

    const response = await request(ctx);
    expect(response.status).toBe(200);
    expect(calculateCost).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();

    await finish?.({ usage: { inputTokens: 25, outputTokens: 12 } });
    await Promise.all(scheduled);
    expect(calculateCost).toHaveBeenCalledWith(
      "gpt-4o",
      "openai",
      25,
      12,
      "openai",
    );
    expect(settle).toHaveBeenCalledWith(0.002);
  });
});
