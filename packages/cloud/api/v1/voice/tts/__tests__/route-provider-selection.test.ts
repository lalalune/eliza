/**
 * Route-level regression coverage for cloud TTS provider admission.
 *
 * These tests stop before synthesis so unsupported Kokoro ids can be proven to
 * fail without touching either upstream provider.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const assertSafeForPublicUse = mock(async () => undefined);
const reserveCredits = mock(async () => ({
  reservationTransactionId: "reservation-1",
  reconcile: async () => undefined,
}));
const billUsage = mock(async (..._args: unknown[]) => ({
  totalCost: 0.001,
  baseTotalCost: 0.001,
  platformMarkup: 0,
}));
const createUsage = mock(async (..._args: unknown[]) => ({ id: "usage-1" }));
type TestTtsClaim =
  | {
      kind: "claimed" | "conflict" | "pending";
      operation: { id: string };
      keyHashPrefix: string;
    }
  | {
      kind: "completed";
      operation: { id: string };
      keyHashPrefix: string;
      result: {
        bytes: Uint8Array;
        contentType: string;
        headers: Record<string, string>;
      };
    }
  | {
      kind: "failed";
      operation: { id: string };
      keyHashPrefix: string;
      status: number;
      body: Record<string, unknown>;
    };
let ttsClaimResult: TestTtsClaim = {
  kind: "claimed" as const,
  operation: { id: "tts-operation-1" },
  keyHashPrefix: "0123456789ab",
};
let ttsWaitResult: TestTtsClaim = {
  kind: "pending" as const,
  operation: { id: "tts-operation-1" },
  keyHashPrefix: "0123456789ab",
};
const claimTtsOperation = mock(async () => ttsClaimResult);
const waitForTtsOperation = mock(async () => ttsWaitResult);
const attachTtsReservation = mock(async () => undefined);
const stageTtsResult = mock(async () => undefined);
const completeTtsOperation = mock(async () => undefined);
const failTtsOperation = mock(async () => undefined);
const elevenLabsTextToSpeech = mock(
  async () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([73, 68, 51]));
        controller.close();
      },
    }),
);
let allowKokoroFetch = false;
let cartesiaStatus = 200;
let cachedVoiceResponse: {
  bytes: Uint8Array;
  byteSize: number;
  contentType: string;
  hitCount: number;
} | null = null;
const fetchMock = Object.assign(
  mock(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = String(args[0]);
    if (url === "https://api.cartesia.ai/tts/bytes") {
      if (cartesiaStatus !== 200) {
        return new Response("provider body must stay private", {
          status: cartesiaStatus,
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([73, 68, 51, 4]));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "audio/mpeg; codec=mp3" } },
      );
    }
    if (allowKokoroFetch) {
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "Content-Type": "audio/wav" },
      });
    }
    throw new Error("fetch must not be called for selection failures");
  }),
  { preconnect: () => undefined },
) satisfies typeof fetch;
const realFetch = globalThis.fetch;

mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {
    statusCode = 500;
  },
}));

mock.module("@elizaos/shared/voice/first-sentence-snip", () => ({
  FIRST_SENTENCE_SNIP_VERSION: "1",
  firstSentenceSnip: (text: string) => {
    const normalized = text.trim();
    if (!normalized) return null;
    return {
      raw: normalized,
      normalized,
      endOffset: text.trimEnd().length,
      wordCount: normalized.split(/\s+/u).length,
    };
  },
}));

mock.module("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code: string;
    context?: Record<string, unknown>;
    severity?: string;
    constructor(
      message: string,
      options: {
        code: string;
        context?: Record<string, unknown>;
        severity?: string;
      },
    ) {
      super(message);
      this.name = "ElizaError";
      this.code = options.code;
      this.context = options.context;
      this.severity = options.severity;
    }
  },
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/db/repositories/user-voices", () => ({
  userVoicesRepository: {
    findByElevenLabsVoiceId: async () => null,
    incrementUsageCount: async () => undefined,
  },
}));

mock.module("@/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse },
}));

mock.module("@/lib/services/ai-pricing", () => ({
  calculateTTSCostFromCatalog: async () => ({
    totalCost: 0.001,
    baseTotalCost: 0.001,
    platformMarkup: 0,
  }),
}));

mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage: billUsage,
}));

mock.module("@/lib/services/credits", () => {
  class InsufficientCreditsError extends Error {
    required = 0;
  }
  return {
    InsufficientCreditsError,
    creditsService: { reserve: reserveCredits },
  };
});

mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: () => ({ textToSpeech: elevenLabsTextToSpeech }),
}));

mock.module("@/lib/services/pcm16-wav", () => ({
  drainPcm16Stream: async () => new Uint8Array([1, 0, 2, 0]),
  pcm16ToWav: (pcm: Uint8Array) => pcm,
}));

mock.module("@/lib/services/tts-first-line-cache", () => ({
  fingerprintCloudVoiceSettings: () => "fp-test",
  getCloudFirstLineCacheService: () => ({
    get: async () => cachedVoiceResponse,
    has: async () => true,
    put: async () => true,
  }),
  shouldBypassCloudFirstLineCache: () => true,
}));

mock.module("@/lib/services/usage", () => ({
  usageService: { create: createUsage },
}));

mock.module("@/lib/services/voice-tts-operations", () => {
  class InvalidVoiceTtsIdempotencyKeyError extends Error {}
  return {
    InvalidVoiceTtsIdempotencyKeyError,
    normalizeVoiceTtsIdempotencyKey: (value: string | null) => value,
    buildCanonicalVoiceTtsRequestHash: async () => "request-hash",
    voiceTtsOperationsService: {
      claim: claimTtsOperation,
      waitForTerminal: waitForTtsOperation,
      attachReservation: attachTtsReservation,
      stageResult: stageTtsResult,
      complete: completeTtsOperation,
      fail: failTtsOperation,
    },
  };
});

mock.module("@/lib/pricing-constants", () => ({
  CUSTOM_VOICE_TTS_MARKUP: 1.2,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let route: {
  default: {
    fetch: (
      request: Request,
      env?: Record<string, unknown>,
    ) => Promise<Response>;
  };
};

beforeAll(async () => {
  globalThis.fetch = fetchMock;
  route = (await import("../route")) as typeof route;
});

beforeEach(() => {
  ttsClaimResult = {
    kind: "claimed",
    operation: { id: "tts-operation-1" },
    keyHashPrefix: "0123456789ab",
  };
  ttsWaitResult = {
    kind: "pending",
    operation: { id: "tts-operation-1" },
    keyHashPrefix: "0123456789ab",
  };
  allowKokoroFetch = false;
  cartesiaStatus = 200;
  cachedVoiceResponse = null;
  fetchMock.mockClear();
  assertSafeForPublicUse.mockClear();
  reserveCredits.mockClear();
  billUsage.mockClear();
  createUsage.mockClear();
  claimTtsOperation.mockClear();
  waitForTtsOperation.mockClear();
  attachTtsReservation.mockClear();
  stageTtsResult.mockClear();
  completeTtsOperation.mockClear();
  failTtsOperation.mockClear();
  elevenLabsTextToSpeech.mockClear();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function postTts(
  body: unknown,
  env: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return route.default.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("POST /api/v1/voice/tts provider selection", () => {
  test("uses Cartesia for an unpinned default when CARTESIA_API_KEY is configured", async () => {
    const response = await postTts(
      { text: "Hello from Cartesia." },
      {
        CARTESIA_API_KEY: "cartesia-key",
        CARTESIA_VOICE_ID: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        KOKORO_TTS_URL: "https://kokoro.example.test",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg; codec=mp3");
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("cartesia");
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([73, 68, 51, 4]).buffer,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.cartesia.ai/tts/bytes",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "X-API-Key": "cartesia-key",
      "Cartesia-Version": "2025-04-16",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model_id: "sonic-3.5",
      transcript: "Hello from Cartesia.",
      voice: { mode: "id", id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" },
      output_format: {
        container: "mp3",
        sample_rate: 44100,
        bit_rate: 128000,
      },
    });
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
    expect(billUsage.mock.calls[0]?.[0]).toMatchObject({
      model: "cartesia/sonic-3.5",
      provider: "cartesia",
      billingSource: "elevenlabs",
    });
    await Promise.resolve();
    expect(createUsage.mock.calls[0]?.[0]).toMatchObject({
      provider: "cartesia",
      model: "sonic-3.5",
    });
  });

  test("maps Cartesia rate limits honestly without falling back to ElevenLabs", async () => {
    cartesiaStatus = 429;
    const response = await postTts(
      { text: "Hello from Cartesia." },
      { CARTESIA_API_KEY: "cartesia-key" },
    );

    expect(response.status).toBe(429);
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
    const body = (await response.json()) as {
      error: string;
      provider: string;
      code: string;
    };
    expect(body).toEqual({
      error:
        "Cartesia text-to-speech is rate limited or quota constrained. Please try again later.",
      provider: "cartesia",
      code: "rate_limit",
    });
  });

  test("treats the proxy-injected legacy default as unpinned when Cartesia is configured", async () => {
    const response = await postTts(
      { text: "Hello.", voiceId: "EXAVITQu4vr4xnSDxMaL" },
      {
        CARTESIA_API_KEY: "cartesia-key",
        KOKORO_TTS_URL: "https://kokoro.example.test",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("cartesia");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.cartesia.ai/tts/bytes",
    );
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).toHaveBeenCalledTimes(1);
  });

  test("uses Kokoro for the proxy-injected legacy default when Cartesia is unset", async () => {
    allowKokoroFetch = true;
    const response = await postTts(
      { text: "Hello.", voiceId: "EXAVITQu4vr4xnSDxMaL" },
      { KOKORO_TTS_URL: "https://kokoro.example.test" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://kokoro.example.test/api/tts",
    );
  });

  test("serves a configured Kokoro cache hit with provider timing headers", async () => {
    cachedVoiceResponse = {
      bytes: new Uint8Array([82, 73, 70, 70]),
      byteSize: 4,
      contentType: "audio/wav",
      hitCount: 2,
    };

    const response = await postTts(
      { text: "Hello.", voiceId: "af_heart" },
      {
        KOKORO_TTS_URL: "https://kokoro.example.test",
        KOKORO_FIRST_LINE_CACHE: "1",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    expect(response.headers.get("X-TTS-Cache")).toBe(
      "hit; kokoro; first-sentence",
    );
    expect(response.headers.get("Server-Timing")).toContain("synthesis;dur=");
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([82, 73, 70, 70]).buffer,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects unsupported Kokoro-shaped voice ids with clear 4xx and no upstream call", async () => {
    const response = await postTts(
      { text: "Hello.", voiceId: "af_not_a_voice" },
      { KOKORO_TTS_URL: "https://kokoro.example.test" },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    const serverTiming = response.headers.get("Server-Timing") ?? "";
    expect(serverTiming).toContain("auth;dur=");
    expect(serverTiming).toContain("admission;dur=");
    const body = (await response.json()) as {
      error: string;
      code: string;
    };
    expect(body).toEqual({
      error: "Unsupported Kokoro voice ID: af_not_a_voice",
      code: "unsupported_kokoro_voice",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
  });

  test("fails a Kokoro voice fast when the provider is unconfigured", async () => {
    const response = await postTts({ text: "Hello.", voiceId: "af_heart" });

    expect(response.status).toBe(503);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    expect(response.headers.get("Server-Timing")).toContain("admission;dur=");
    const body = (await response.json()) as {
      error: string;
      code: string;
    };
    expect(body).toEqual({
      error: "Kokoro TTS is not configured for this environment.",
      code: "kokoro_unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
  });

  test("rejects an empty text body before any provider selection or upstream call", async () => {
    const response = await postTts(
      { text: "", voiceId: "af_heart" },
      { KOKORO_TTS_URL: "https://kokoro.example.test" },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body).toEqual({ error: "No text provided" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
  });

  test("preserves ElevenLabs routing and observability for a custom voice", async () => {
    const response = await postTts(
      {
        text: "Hello from a custom voice.",
        voiceId: "custom-elevenlabs-voice",
      },
      { CARTESIA_API_KEY: "cartesia-key" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("elevenlabs");
    const serverTiming = response.headers.get("Server-Timing") ?? "";
    expect(serverTiming).toContain("auth;dur=");
    expect(serverTiming).toContain("admission;dur=");
    expect(serverTiming).toContain("synthesis;dur=");
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([73, 68, 51]).buffer,
    );
    expect(elevenLabsTextToSpeech).toHaveBeenCalledTimes(1);
    expect(elevenLabsTextToSpeech).toHaveBeenCalledWith({
      text: "Hello from a custom voice.",
      voiceId: "custom-elevenlabs-voice",
      modelId: undefined,
    });
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("claims before synthesis and reserves with the server operation id", async () => {
    const response = await postTts(
      { text: "Bill me once.", voiceId: "custom-elevenlabs-voice" },
      { BLOB: {} },
      { "Idempotency-Key": "utterance-abc" },
    );
    expect(response.status).toBe(200);
    expect(claimTtsOperation).toHaveBeenCalledTimes(1);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    const keyedArgs = reserveCredits.mock.calls[0] as unknown as
      | [Record<string, unknown>]
      | undefined;
    expect(keyedArgs?.[0]).toMatchObject({
      idempotencyKey: "tts-operation-1",
    });
    expect(attachTtsReservation).toHaveBeenCalledWith(
      "tts-operation-1",
      "reservation-1",
    );
    expect(stageTtsResult).toHaveBeenCalledTimes(1);
    expect(completeTtsOperation).toHaveBeenCalledWith({
      operationId: "tts-operation-1",
      usageRecordId: "usage-1",
    });
  });

  test("replays completed audio without safety, provider, or billing work", async () => {
    ttsClaimResult = {
      kind: "completed",
      operation: { id: "tts-operation-1" },
      keyHashPrefix: "0123456789ab",
      result: {
        bytes: new Uint8Array([82, 69, 80, 76, 65, 89]),
        contentType: "audio/mpeg",
        headers: { "X-Eliza-TTS-Provider": "elevenlabs" },
      },
    };

    const response = await postTts(
      { text: "Bill me once.", voiceId: "custom-elevenlabs-voice" },
      { BLOB: {} },
      { "Idempotency-Key": "utterance-abc" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-TTS-Idempotent-Replay")).toBe("true");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([82, 69, 80, 76, 65, 89]),
    );
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
    expect(createUsage).not.toHaveBeenCalled();
  });

  test("rejects a key bound to another payload before external work", async () => {
    ttsClaimResult = {
      kind: "conflict",
      operation: { id: "tts-operation-1" },
      keyHashPrefix: "0123456789ab",
    };

    const response = await postTts(
      { text: "Different text.", voiceId: "custom-elevenlabs-voice" },
      { BLOB: {} },
      { "Idempotency-Key": "utterance-abc" },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "idempotency_key_conflict",
    });
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
  });

  test("waits for an in-flight duplicate and returns the winner's audio", async () => {
    ttsClaimResult = {
      kind: "pending",
      operation: { id: "tts-operation-1" },
      keyHashPrefix: "0123456789ab",
    };
    ttsWaitResult = {
      kind: "completed",
      operation: { id: "tts-operation-1" },
      keyHashPrefix: "0123456789ab",
      result: {
        bytes: new Uint8Array([87, 73, 78]),
        contentType: "audio/mpeg",
        headers: {},
      },
    };

    const response = await postTts(
      { text: "Bill me once.", voiceId: "custom-elevenlabs-voice" },
      { BLOB: {} },
      { "Idempotency-Key": "utterance-abc" },
    );

    expect(response.status).toBe(200);
    expect(waitForTtsOperation).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([87, 73, 78]),
    );
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
  });

  test("without the header the reservation stays unkeyed (behavior unchanged)", async () => {
    const response = await postTts({
      text: "Hi.",
      voiceId: "custom-elevenlabs-voice",
    });
    expect(response.status).toBe(200);
    const unkeyedArgs = reserveCredits.mock.calls[0] as unknown as
      | [Record<string, unknown>]
      | undefined;
    expect("idempotencyKey" in (unkeyedArgs?.[0] ?? {})).toBe(false);
  });

  test("rejects an invalid body and an over-long text before any reservation", async () => {
    const bad = await postTts({ voiceId: "custom-elevenlabs-voice" });
    expect(bad.status).toBe(400);

    const tooLong = await postTts({
      text: "x".repeat(5001),
      voiceId: "custom-elevenlabs-voice",
    });
    expect(tooLong.status).toBe(400);

    expect(reserveCredits).not.toHaveBeenCalled();
  });
});
