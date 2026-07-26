/**
 * Exercises Steward's serialized, authenticated user-session revocation.
 *
 * The fixture uses a real Request/Response boundary while isolating the
 * external Steward service and request-signing implementation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const signStewardMutatingRequest = mock<
  (
    _secret: string,
    _method: string,
    _pathAndSearch: string,
    _headers: Headers,
    _body: BufferSource,
  ) => Promise<void>
>(async () => undefined);
mock.module("@/lib/steward/sign", () => ({ signStewardMutatingRequest }));

const { revokeStewardUserSessions } = await import(
  "./steward-refresh-token-revocation"
);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  signStewardMutatingRequest.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("revokeStewardUserSessions", () => {
  test("signs a bodyless authenticated DELETE to Steward's locked session boundary", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://steward.example.test/auth/sessions",
        );
        expect(init?.method).toBe("DELETE");
        expect(init?.body).toBeUndefined();
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(
          "Bearer current-access-token",
        );
        expect(headers.get("content-type")).toBeNull();
        expect(headers.get("x-steward-tenant")).toBe("elizacloud");
        return Response.json({ ok: true });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await revokeStewardUserSessions("current-access-token", {
      STEWARD_API_URL: "https://steward.example.test/",
      STEWARD_REQUEST_SIGNING_SECRET: "signing-secret",
      STEWARD_TENANT_ID: "elizacloud",
    });

    expect(signStewardMutatingRequest).toHaveBeenCalledTimes(1);
    expect(signStewardMutatingRequest.mock.calls[0]?.slice(0, 3)).toEqual([
      "signing-secret",
      "DELETE",
      "/auth/sessions",
    ]);
    expect(
      new Headers(signStewardMutatingRequest.mock.calls[0]?.[3]).get(
        "authorization",
      ),
    ).toBe("Bearer current-access-token");
    const signedBody = signStewardMutatingRequest.mock.calls[0]?.[4];
    expect(signedBody).toBeInstanceOf(Uint8Array);
    if (!(signedBody instanceof Uint8Array)) {
      throw new Error("Expected the signed request body to be a Uint8Array");
    }
    expect(signedBody.byteLength).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("fails closed when the upstream rejects revocation", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: false }, { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      revokeStewardUserSessions("current-access-token", {
        STEWARD_API_URL: "https://steward.example.test",
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_REVOCATION_REJECTED",
    });
  });

  test("rejects a semantic failure carried in a successful HTTP response", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: false, error: "not revoked" }),
    ) as unknown as typeof fetch;

    await expect(
      revokeStewardUserSessions("current-access-token", {
        STEWARD_API_URL: "https://steward.example.test",
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_REVOCATION_UNCONFIRMED",
    });
  });

  test.each([
    ["empty", new Response(null, { status: 200 })],
    [
      "malformed",
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
    ["ambiguous", Response.json({ success: true })],
  ])(
    "rejects an %s 2xx response without explicit ok true",
    async (_name, response) => {
      globalThis.fetch = mock(async () => response) as unknown as typeof fetch;

      await expect(
        revokeStewardUserSessions("current-access-token", {
          STEWARD_API_URL: "https://steward.example.test",
        }),
      ).rejects.toMatchObject({
        code: "STEWARD_SESSION_REVOCATION_UNCONFIRMED",
      });
    },
  );

  test("fails closed when no authoritative upstream is configured", async () => {
    await expect(
      revokeStewardUserSessions("current-access-token", {}),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_REVOCATION_UPSTREAM_MISSING",
    });
  });
});
