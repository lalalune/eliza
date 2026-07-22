/**
 * Unit coverage for the iOS in-renderer kernel's local-inference routes.
 * In-process, no real device.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type KernelModule = Pick<
  typeof import("./ios-local-agent-kernel"),
  "handleIosLocalAgentRequest"
>;

type DownloadModelFn = (
  _url: string,
  filename: string,
) => Promise<{ path: string }>;
type HashFileFn = (
  path: string,
) => Promise<{ sha256: string; sizeBytes: number }>;
type GetDownloadProgressFn = (_url: string) => Promise<{
  downloaded: number;
  total: number;
  percentage: number;
  bytesPerSec: number;
  etaMs: null;
}>;
type LoadFn = (_options: Record<string, unknown>) => Promise<undefined>;
type GenerateFn = (_options: Record<string, unknown>) => Promise<{
  text: string;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
}>;

type TestBundleRecord = {
  modelId: string;
  bundleVersion: string;
  files: Record<string, string>;
  installedAt: string;
};

type MockOptions = {
  hardware?: Record<string, unknown>;
  availableModels?: Array<{ name?: string; path?: string; size?: number }>;
  bundleRecords?: TestBundleRecord[];
  downloadModel?: DownloadModelFn;
  hashFile?: HashFileFn;
  getDownloadProgress?: GetDownloadProgressFn;
  load?: LoadFn;
  generate?: GenerateFn;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const BUNDLE_INDEX_KEY = "eliza:ios-local-agent:eliza-1-bundles:v1";

function eliza1MobileManifest(modelId = "eliza-1-2b"): Record<string, unknown> {
  // Must match the catalog's ggufFile for the tier — the kernel's manifest
  // validation requires files.text to contain model.ggufFile exactly. The 4B
  // bundle ships the 128k GGUF (run at a 64k context on mobile via load args).
  const textPath =
    modelId === "eliza-1-4b"
      ? "text/eliza-1-4b-128k.gguf"
      : "text/eliza-1-2b-128k.gguf";
  const drafterPath =
    modelId === "eliza-1-4b" ? "mtp/drafter-4b.gguf" : "mtp/drafter-2b.gguf";

  return {
    id: modelId,
    version: "1.0.0",
    defaultEligible: true,
    files: {
      text: [
        {
          path: textPath,
          sha256: "0".repeat(64),
          ctx: modelId === "eliza-1-4b" ? 65536 : 131072,
        },
      ],
      voice: [
        {
          path: "voice/eliza-voice.codec",
          sha256: "0".repeat(64),
        },
      ],
      asr: [
        {
          path: "asr/eliza-asr.codec",
          sha256: "0".repeat(64),
        },
      ],
      vision: [],
      mtp: [
        {
          path: drafterPath,
          sha256: "0".repeat(64),
          ctx: 32768,
        },
      ],
      cache: [
        {
          path: `cache/${modelId}.kvcache`,
          sha256: "0".repeat(64),
        },
      ],
      vad: [
        {
          path: "vad/eliza-vad.bin",
          sha256: "0".repeat(64),
        },
      ],
    },
  };
}

const mockState = vi.hoisted(
  (): {
    hardware: Record<string, unknown>;
    availableModels: Array<{ name?: string; path?: string; size?: number }>;
    downloadModel: DownloadModelFn;
    hashFile: HashFileFn;
    getDownloadProgress: GetDownloadProgressFn;
    load: LoadFn;
    generate: GenerateFn;
  } => ({
    hardware: {},
    availableModels: [],
    downloadModel: vi.fn(async (_url: string, filename: string) => ({
      path: `/models/${filename}`,
    })),
    hashFile: vi.fn(async () => ({
      sha256: "0".repeat(64),
      sizeBytes: 1024,
    })),
    getDownloadProgress: vi.fn(async (_url: string) => ({
      downloaded: 0,
      total: 0,
      percentage: 0,
      bytesPerSec: 0,
      etaMs: null,
    })),
    load: vi.fn(async (_options: Record<string, unknown>) => undefined),
    generate: vi.fn(async (_options: Record<string, unknown>) => ({
      text: "native answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 10,
    })),
  }),
);

vi.mock("@elizaos/capacitor-llama", () => ({
  capacitorLlama: {
    getHardwareInfo: vi.fn(async () => ({
      platform: "ios",
      deviceModel: "iPhone16,1",
      machineId: "iPhone16,1",
      osVersion: "26.3.1",
      isSimulator: false,
      totalRamGb: 8,
      availableRamGb: 5,
      freeStorageGb: 64,
      cpuCores: 8,
      gpu: { backend: "metal", available: true },
      gpuSupported: true,
      mtpSupported: true,
      source: "native",
      ...mockState.hardware,
    })),
    isLoaded: vi.fn(async () => ({ loaded: false, modelPath: null })),
    currentModelPath: vi.fn(() => null),
    load: (options: Record<string, unknown>) => mockState.load(options),
    generate: (options: Record<string, unknown>) => mockState.generate(options),
  },
}));

vi.mock("llama-cpp-capacitor", () => ({
  downloadModel: (url: string, filename: string) =>
    mockState.downloadModel(url, filename),
  hashFile: (path: string) => mockState.hashFile(path),
  getDownloadProgress: (url: string) => mockState.getDownloadProgress(url),
  cancelDownload: vi.fn(async () => true),
  getAvailableModels: vi.fn(async () => mockState.availableModels),
}));

import { handleIosLocalAgentRequest } from "./ios-local-agent-kernel";

function stubLocalStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      items.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      items.delete(key);
    }),
    clear: vi.fn(() => {
      items.clear();
    }),
    key: vi.fn((index: number) => [...items.keys()][index] ?? null),
    get length() {
      return items.size;
    },
  } as Storage;
}

function verifiedEliza1BundleRecord(
  modelId: string,
  modelPath: string,
): TestBundleRecord {
  const fileName = modelPath.split("/").pop() ?? `${modelId}-128k.gguf`;
  return {
    modelId,
    bundleVersion: "1.0.0",
    files: {
      [`text/${fileName}`]: modelPath,
    },
    installedAt: "2026-05-11T01:00:00.000Z",
  };
}

async function loadKernel(options: MockOptions = {}): Promise<KernelModule> {
  mockState.hardware = options.hardware ?? {};
  mockState.availableModels = options.availableModels ?? [];
  mockState.downloadModel =
    options.downloadModel ??
    vi.fn(async (_url: string, filename: string) => ({
      path: `/models/${filename}`,
    }));
  mockState.hashFile =
    options.hashFile ??
    vi.fn(async () => ({
      sha256: "0".repeat(64),
      sizeBytes: 1024,
    }));
  mockState.getDownloadProgress =
    options.getDownloadProgress ??
    vi.fn(async (_url: string) => ({
      downloaded: 0,
      total: 0,
      percentage: 0,
      bytesPerSec: 0,
      etaMs: null,
    }));
  mockState.load =
    options.load ??
    vi.fn(async (_options: Record<string, unknown>) => undefined);
  mockState.generate =
    options.generate ??
    vi.fn(async (_options: Record<string, unknown>) => ({
      text: "native answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 10,
    }));

  const localStorage = stubLocalStorage();
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      // The kernel builds a tier-agnostic manifest URL (eliza-1.manifest.json),
      // so the only signal is an explicit 2B id in the URL. Everything else —
      // including the recommended-default download — resolves to the 4B
      // manifest, matching the shipped mobile default.
      const url = String(input);
      const modelId =
        url.includes("eliza-1-2b") || url.includes("/2b/")
          ? "eliza-1-2b"
          : "eliza-1-4b";
      return Response.json(eliza1MobileManifest(modelId), {
        status: 200,
      });
    }),
  );

  await handleIosLocalAgentRequest(
    new Request("http://127.0.0.1:31337/api/agent/reset", {
      method: "POST",
      body: "{}",
    }),
  );
  if (options.bundleRecords?.length) {
    localStorage.setItem(
      BUNDLE_INDEX_KEY,
      JSON.stringify(
        Object.fromEntries(
          options.bundleRecords.map((record) => [record.modelId, record]),
        ),
      ),
    );
  }
  return { handleIosLocalAgentRequest };
}

async function jsonRequest(
  kernel: KernelModule,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const response = await kernel.handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  expect(response.status).toBeLessThan(400);
  return response.json();
}

async function eventually(
  assertion: () => void | Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("iOS local-agent local inference flow", () => {
  afterEach(async () => {
    await handleIosLocalAgentRequest(
      new Request("http://127.0.0.1:31337/api/agent/reset", {
        method: "POST",
        body: "{}",
      }),
    ).catch(() => undefined);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("answers with local model download status while queueing the recommended target", async () => {
    const downloadModel = vi.fn(async (_url: string, filename: string) => ({
      path: `/models/${filename}`,
    }));
    const kernel = await loadKernel({ downloadModel });

    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Download test",
    })) as { conversation: { id: string } };

    const reply = (await jsonRequest(
      kernel,
      "POST",
      `/api/conversations/${created.conversation.id}/messages`,
      { text: "hello" },
    )) as {
      text: string;
      localInference?: { status?: string; modelId?: string | null };
    };

    expect(reply.localInference).toMatchObject({
      status: "downloading",
      modelId: "eliza-1-4b",
    });
    expect(reply.text.toLowerCase()).toContain("downloading");

    await eventually(() => {
      const filenames = downloadModel.mock.calls.map((call) => call[1]);
      expect(filenames).toContain("eliza-1-4b.manifest.json");
      expect(filenames).toContain("eliza-1-4b-128k.gguf");
      expect(mockState.hashFile).toHaveBeenCalledWith(
        "/models/eliza-1-4b.manifest.json",
      );
      expect(mockState.hashFile).toHaveBeenCalledWith(
        "/models/eliza-1-4b-128k.gguf",
      );
    });
  }, 30_000);

  it("warns from greeting when the default local model still needs download", async () => {
    const kernel = await loadKernel();

    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Greeting test",
    })) as { conversation: { id: string } };

    const greeting = (await jsonRequest(
      kernel,
      "POST",
      `/api/conversations/${created.conversation.id}/greeting`,
    )) as {
      text: string;
      localInference?: { status?: string; modelId?: string | null };
    };

    expect(greeting.text).not.toContain("I'm running locally on this device.");
    expect(greeting.text.toLowerCase()).toContain("downloading");
    expect(greeting.localInference).toMatchObject({
      status: "downloading",
      modelId: "eliza-1-4b",
    });
  });

  it("fails an Eliza-1 bundle download when a native SHA256 check mismatches", async () => {
    const kernel = await loadKernel({
      hashFile: vi.fn(async (path: string) => ({
        sha256: path.endsWith(".manifest.json")
          ? "0".repeat(64)
          : "f".repeat(64),
        sizeBytes: 1024,
      })),
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/downloads", {
      modelId: "eliza-1-4b",
    });

    await eventually(async () => {
      const response = await kernel.handleIosLocalAgentRequest(
        new Request(
          "http://127.0.0.1:31337/api/local-inference/downloads/eliza-1-4b",
        ),
      );
      const payload = (await response.json()) as {
        job?: { state?: string; error?: string };
      };
      expect(payload.job?.state).toBe("failed");
      expect(payload.job?.error).toContain("SHA256 mismatch");
    });
  });

  it("uses a simulator RAM fallback when native hardware omits memory", async () => {
    const kernel = await loadKernel({
      hardware: {
        totalRamGb: undefined,
        availableRamGb: undefined,
        isSimulator: true,
      },
    });

    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Simulator memory fallback",
    })) as { conversation: { id: string } };

    const reply = (await jsonRequest(
      kernel,
      "POST",
      `/api/conversations/${created.conversation.id}/messages`,
      { text: "download the default local model" },
    )) as {
      text: string;
      localInference?: { status?: string; modelId?: string | null };
    };

    expect(reply.localInference).toMatchObject({
      status: "downloading",
      modelId: "eliza-1-4b",
    });
  });

  it("passes mobile load options into the native iOS load call when the recommended model is installed", async () => {
    const load = vi.fn(async (_options: Record<string, unknown>) => undefined);
    const kernel = await loadKernel({
      load,
      availableModels: [
        {
          name: "eliza-1-2b-128k.gguf",
          path: "/models/eliza-1-2b-128k.gguf",
          size: 1_200_000_000,
        },
      ],
      bundleRecords: [
        verifiedEliza1BundleRecord(
          "eliza-1-2b",
          "/models/eliza-1-2b-128k.gguf",
        ),
      ],
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "eliza-1-2b",
    });

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: "/models/eliza-1-2b-128k.gguf",
        contextSize: 6144,
        maxThreads: 6,
        useGpu: true,
      }),
    );
    expect(load.mock.calls[0]?.[0]).not.toHaveProperty("draftModelPath");
  });

  it("dedupes a retried local send with the exact persisted user-message receipt", async () => {
    const generate = vi.fn(async (_options: Record<string, unknown>) => ({
      text: "local answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 10,
    }));
    const kernel = await loadKernel({
      generate,
      availableModels: [
        {
          name: "eliza-1-2b-128k.gguf",
          path: "/models/eliza-1-2b-128k.gguf",
          size: 1_200_000_000,
        },
      ],
      bundleRecords: [
        verifiedEliza1BundleRecord(
          "eliza-1-2b",
          "/models/eliza-1-2b-128k.gguf",
        ),
      ],
    });
    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "eliza-1-2b",
    });
    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Receipt test",
    })) as { conversation: { id: string } };
    const path = `/api/conversations/${created.conversation.id}/messages`;
    const body = { text: "hello", clientMessageId: "ios-retry-1" };

    const first = (await jsonRequest(kernel, "POST", path, body)) as {
      receipt: {
        conversationId: string;
        clientMessageId: string;
        userMessageId: string;
      };
    };
    const retry = (await jsonRequest(kernel, "POST", path, body)) as {
      receipt: typeof first.receipt;
    };
    const history = (await jsonRequest(kernel, "GET", path)) as {
      messages: Array<{ id: string; role: string }>;
    };

    expect(generate).toHaveBeenCalledTimes(1);
    expect(retry.receipt).toEqual(first.receipt);
    expect(first.receipt).toMatchObject({
      conversationId: created.conversation.id,
      clientMessageId: "ios-retry-1",
    });
    expect(first.receipt.userMessageId).toBe(
      history.messages.find((message) => message.role === "user")?.id,
    );
  });

  it("resumes a failed local generation from the persisted user turn exactly once", async () => {
    type GeneratedReply = {
      text: string;
      promptTokens: number;
      outputTokens: number;
      durationMs: number;
    };
    const resumedGeneration = deferred<GeneratedReply>();
    const aborted = Object.assign(new Error("first inference aborted"), {
      name: "AbortError",
    });
    const generate = vi
      .fn()
      .mockRejectedValueOnce(aborted)
      .mockImplementationOnce(async () => resumedGeneration.promise);
    const kernel = await loadKernel({
      generate,
      availableModels: [
        {
          name: "eliza-1-2b-128k.gguf",
          path: "/models/eliza-1-2b-128k.gguf",
          size: 1_200_000_000,
        },
      ],
      bundleRecords: [
        verifiedEliza1BundleRecord(
          "eliza-1-2b",
          "/models/eliza-1-2b-128k.gguf",
        ),
      ],
    });
    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "eliza-1-2b",
    });
    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Failed receipt retry test",
    })) as { conversation: { id: string } };
    const path = `/api/conversations/${created.conversation.id}/messages`;
    const body = { text: "original turn", clientMessageId: "ios-failed-1" };

    await expect(
      kernel.handleIosLocalAgentRequest(
        new Request(`http://127.0.0.1:31337${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
    ).rejects.toThrow("first inference aborted");

    const failedHistory = (await jsonRequest(kernel, "GET", path)) as {
      messages: Array<{
        id: string;
        role: string;
        generationState?: string;
      }>;
    };
    const persistedUser = failedHistory.messages.find(
      (message) => message.role === "user",
    );
    expect(persistedUser).toMatchObject({ generationState: "failed" });
    expect(
      failedHistory.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(0);

    const resumedPromise = jsonRequest(kernel, "POST", path, {
      text: "tampered retry payload",
      clientMessageId: body.clientMessageId,
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));

    // A concurrent duplicate observes the durable receipt but may not launch a
    // second regeneration while the retry owns the persisted user turn.
    const concurrent = (await jsonRequest(kernel, "POST", path, body)) as {
      text: string;
      receipt: {
        conversationId: string;
        clientMessageId: string;
        userMessageId: string;
      };
    };
    expect(concurrent).toMatchObject({
      text: "",
      receipt: {
        conversationId: created.conversation.id,
        clientMessageId: body.clientMessageId,
        userMessageId: persistedUser?.id,
      },
    });
    expect(generate).toHaveBeenCalledTimes(2);

    resumedGeneration.resolve({
      text: "recovered answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 12,
    });
    const resumed = (await resumedPromise) as {
      text: string;
      receipt: typeof concurrent.receipt;
    };
    expect(resumed).toMatchObject({
      text: "recovered answer",
      receipt: concurrent.receipt,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0]).toMatchObject({
      prompt: expect.stringContaining("original turn"),
    });
    expect(generate.mock.calls[1]?.[0]).toMatchObject({
      prompt: expect.not.stringContaining("tampered retry payload"),
    });

    const finalHistory = (await jsonRequest(kernel, "GET", path)) as {
      messages: Array<{ role: string; generationState?: string }>;
    };
    expect(
      finalHistory.messages.filter((message) => message.role === "user"),
    ).toEqual([expect.objectContaining({ generationState: "completed" })]);
    expect(
      finalHistory.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  it("returns the durable receipt to a retry while local inference is in flight", async () => {
    type GeneratedReply = {
      text: string;
      promptTokens: number;
      outputTokens: number;
      durationMs: number;
    };
    const firstGeneration = deferred<GeneratedReply>();
    const secondGeneration = deferred<GeneratedReply>();
    const generate = vi
      .fn()
      .mockImplementationOnce(async () => firstGeneration.promise)
      .mockImplementationOnce(async () => secondGeneration.promise);
    const kernel = await loadKernel({
      generate,
      availableModels: [
        {
          name: "eliza-1-2b-128k.gguf",
          path: "/models/eliza-1-2b-128k.gguf",
          size: 1_200_000_000,
        },
      ],
      bundleRecords: [
        verifiedEliza1BundleRecord(
          "eliza-1-2b",
          "/models/eliza-1-2b-128k.gguf",
        ),
      ],
    });
    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "eliza-1-2b",
    });
    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Concurrent receipt test",
    })) as { conversation: { id: string } };
    const path = `/api/conversations/${created.conversation.id}/messages`;
    const body = { text: "hello", clientMessageId: "ios-concurrent-1" };
    const firstPromise = jsonRequest(kernel, "POST", path, body);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    const retry = (await jsonRequest(kernel, "POST", path, body)) as {
      receipt: {
        conversationId: string;
        clientMessageId: string;
        userMessageId: string;
      };
    };
    const history = (await jsonRequest(kernel, "GET", path)) as {
      messages: Array<{ id: string; role: string }>;
    };
    expect(retry.receipt.userMessageId).toBe(
      history.messages.find((message) => message.role === "user")?.id,
    );
    expect(
      history.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);

    // A distinct turn can persist and finish while the first inference waits.
    // The first completion must merge into the latest store, not overwrite it.
    const otherPromise = jsonRequest(kernel, "POST", path, {
      text: "second turn",
      clientMessageId: "ios-concurrent-2",
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    secondGeneration.resolve({
      text: "second answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 10,
    });
    await otherPromise;
    firstGeneration.resolve({
      text: "local answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 12,
    });
    const first = (await firstPromise) as { receipt: typeof retry.receipt };
    expect(first.receipt).toEqual(retry.receipt);
    expect(generate).toHaveBeenCalledTimes(2);
    const finalHistory = (await jsonRequest(kernel, "GET", path)) as {
      messages: Array<{ role: string }>;
    };
    expect(
      finalHistory.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    expect(
      finalHistory.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(2);

    const firstRetry = (await jsonRequest(kernel, "POST", path, body)) as {
      text: string;
      receipt: typeof retry.receipt;
    };
    const secondRetry = (await jsonRequest(kernel, "POST", path, {
      text: "second turn",
      clientMessageId: "ios-concurrent-2",
    })) as { text: string };
    expect(firstRetry).toMatchObject({
      text: "local answer",
      receipt: retry.receipt,
    });
    expect(secondRetry.text).toBe("second answer");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("reports bundled voice assets separately from TTS engine readiness", async () => {
    const kernel = await loadKernel({
      availableModels: [
        {
          name: "eliza-1-2b-128k.gguf",
          path: "/models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf",
          size: 600_000_000,
        },
        {
          name: "kokoro-82m-v1_0-Q4_K_M.gguf",
          path: "/models/eliza-1-2b.bundle/tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf",
          size: 200_000_000,
        },
        {
          name: "af_bella.bin",
          path: "/models/eliza-1-2b.bundle/tts/kokoro/voices/af_bella.bin",
          size: 500_000,
        },
      ],
    });

    const hub = (await jsonRequest(
      kernel,
      "GET",
      "/api/local-inference/hub",
    )) as {
      voiceReadiness?: {
        status?: string;
        installedFiles?: number;
        modelId?: string | null;
        message?: string;
      };
    };

    expect(hub.voiceReadiness).toMatchObject({
      status: "unavailable",
      installedFiles: 2,
      modelId: "eliza-1-2b",
    });
    expect(hub.voiceReadiness?.message).toContain(
      "missing the iOS local voice playback engine",
    );

    const response = await kernel.handleIosLocalAgentRequest(
      new Request("http://127.0.0.1:31337/api/tts/local-inference", {
        method: "POST",
        body: JSON.stringify({ text: "Hello from Eliza." }),
      }),
    );
    const body = (await response.json()) as {
      code?: string;
      voiceReadiness?: { status?: string };
    };
    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: "ios_local_tts_executor_missing",
      voiceReadiness: { status: "unavailable" },
    });
  });

  it("does not pass a drafter to native iOS load for the current Eliza-1 mobile catalog", async () => {
    const load = vi.fn(async (_options: Record<string, unknown>) => undefined);
    const kernel = await loadKernel({
      load,
      hardware: {
        mtpSupported: true,
      },
      availableModels: [
        {
          name: "eliza-1-2b-128k.gguf",
          path: "/models/eliza-1-2b-128k.gguf",
          size: 1_200_000_000,
        },
      ],
      bundleRecords: [
        verifiedEliza1BundleRecord(
          "eliza-1-2b",
          "/models/eliza-1-2b-128k.gguf",
        ),
      ],
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "eliza-1-2b",
    });

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: "/models/eliza-1-2b-128k.gguf",
        useGpu: true,
      }),
    );
    expect(load.mock.calls[0]?.[0]).not.toHaveProperty("draftModelPath");
  });
});
