// Pins the error-policy boundary of LinkedIn ad-credential validation: a failed
// account-discovery fetch (transport reject or non-2xx) must surface its real
// error and stay DISTINCT from a valid-but-empty account list. Deterministic —
// global fetch is mocked; no live LinkedIn calls.
import { afterEach, describe, expect, mock, test } from "bun:test";

const originalFetch = globalThis.fetch;
const downloadAdMedia = mock(async () => ({
  url: "https://media.example.test/ad.mp4",
  bytes: new Uint8Array([1, 2, 3, 4]),
  base64: "AQIDBA==",
  contentType: "video/mp4",
  fileName: "ad.mp4",
}));

mock.module("../media-utils", () => ({
  downloadAdMedia,
  mediaFileName: () => "ad.mp4",
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function loadProvider() {
  const { linkedinAdsProvider, linkedinFetch } = await import("./linkedin");
  return { provider: linkedinAdsProvider, linkedinFetch };
}

const credentials = { accessToken: "linkedin-token" };
const EMPTY_ERROR = "No LinkedIn ad accounts found or invalid credentials";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("linkedinAdsProvider.validateCredentials error policy", () => {
  test("a network/transport failure surfaces the real error, not the empty-list message", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("network unreachable");
    // Transport failure must NOT be reported as a legitimately-empty account list.
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a non-2xx LinkedIn response surfaces the API error, distinct from empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ message: "Invalid access token" }, 401),
    ) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid access token");
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a successful fetch with zero accounts is the DISTINCT legitimately-empty result", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ elements: [] })) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result).toEqual({ valid: false, error: EMPTY_ERROR });
  });

  test("a successful fetch with an account validates without an error", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ elements: [{ id: 507404993, name: "Dunder Mifflin Account" }] }),
    ) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result).toEqual({
      valid: true,
      accountId: "507404993",
      accountName: "Dunder Mifflin Account",
    });
  });
});

describe("linkedinFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung LinkedIn API hop at the timeout", async () => {
    // An API that never settles on its own: the only way out is the caller's
    // AbortSignal firing (the 30s default bounds every ads / upload hop).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const start = Date.now();
    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("keeps the deadline when a caller signal never aborts", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as typeof fetch;

    const { linkedinFetch } = await loadProvider();
    const controller = new AbortController();
    await expect(
      linkedinFetch(
        "https://api.linkedin.com/rest/adAccountsV2",
        { signal: controller.signal },
        100,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(seen).not.toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });

  test("bounds a response body that never completes", async () => {
    globalThis.fetch = mock(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
        ),
      ),
    ) as typeof fetch;
    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("clears the deadline after a successful body read", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return jsonResponse({ elements: [] });
    }) as typeof fetch;
    const { linkedinFetch } = await loadProvider();
    const response = await linkedinFetch(
      "https://api.linkedin.com/rest/adAccountsV2",
      undefined,
      50,
    );
    expect(await response.json()).toEqual({ elements: [] });
    await Bun.sleep(100);
    expect(seen?.aborted).toBe(false);
  });
});

describe("linkedinAdsProvider upload authority and work bounds", () => {
  test("rejects an untrusted image upload URL before forwarding bearer credentials", async () => {
    const fetchMock = mock()
      .mockResolvedValueOnce(jsonResponse({ reference: "urn:li:organization:1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          value: { uploadUrl: "https://attacker.example/upload", image: "urn:li:image:1" },
        }),
      );
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
      type: "image",
      url: "https://media.example.test/ad.png",
    });
    expect(result).toMatchObject({ success: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("rejects invalid video byte ranges before the first upload PUT", async () => {
    const fetchMock = mock()
      .mockResolvedValueOnce(jsonResponse({ reference: "urn:li:organization:1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          value: {
            video: "urn:li:video:1",
            uploadInstructions: [
              { uploadUrl: "https://www.linkedin.com/dms-uploads/1", firstByte: 1, lastByte: 3 },
            ],
          },
        }),
      );
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
      type: "video",
      url: "https://media.example.test/ad.mp4",
    });
    expect(result).toMatchObject({ success: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("uploads validated video parts in order without forwarding the OAuth bearer", async () => {
    const fetchMock = mock()
      .mockResolvedValueOnce(jsonResponse({ reference: "urn:li:organization:1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          value: {
            video: "urn:li:video:1",
            uploadToken: "token",
            uploadInstructions: [
              { uploadUrl: "https://www.linkedin.com/dms-uploads/1", firstByte: 0, lastByte: 1 },
              { uploadUrl: "https://www.linkedin.com/dms-uploads/2", firstByte: 2, lastByte: 3 },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { headers: { etag: "part-1" } }))
      .mockResolvedValueOnce(new Response(null, { headers: { etag: "part-2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
      type: "video",
      url: "https://media.example.test/ad.mp4",
    });
    expect(result).toMatchObject({ success: true, metadata: { parts: 2 } });
    for (const call of [fetchMock.mock.calls[2], fetchMock.mock.calls[3]]) {
      const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("content-type")).toBe("application/octet-stream");
    }
  });
});
