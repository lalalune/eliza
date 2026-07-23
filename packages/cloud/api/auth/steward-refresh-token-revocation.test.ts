/**
 * Exercises the authoritative Steward refresh-token revocation request.
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

const { revokeStewardRefreshToken } = await import(
  "./steward-refresh-token-revocation"
);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  signStewardMutatingRequest.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("revokeStewardRefreshToken", () => {
  test("signs and posts the refresh credential to Steward's revoke boundary", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://steward.example.test/auth/revoke");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(
          JSON.stringify({ refreshToken: "copied-refresh-token" }),
        );
        expect(new Headers(init?.headers).get("x-steward-tenant")).toBe(
          "elizacloud",
        );
        return Response.json({ ok: true });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await revokeStewardRefreshToken("copied-refresh-token", {
      STEWARD_API_URL: "https://steward.example.test/",
      STEWARD_REQUEST_SIGNING_SECRET: "signing-secret",
      STEWARD_TENANT_ID: "elizacloud",
    });

    expect(signStewardMutatingRequest).toHaveBeenCalledTimes(1);
    expect(signStewardMutatingRequest.mock.calls[0]?.slice(0, 3)).toEqual([
      "signing-secret",
      "POST",
      "/auth/revoke",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("fails closed when the upstream rejects revocation", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: false }, { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      revokeStewardRefreshToken("copied-refresh-token", {
        STEWARD_API_URL: "https://steward.example.test",
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_REFRESH_REVOCATION_REJECTED",
    });
  });

  test("rejects a semantic failure carried in a successful HTTP response", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: false, error: "not revoked" }),
    ) as unknown as typeof fetch;

    await expect(
      revokeStewardRefreshToken("copied-refresh-token", {
        STEWARD_API_URL: "https://steward.example.test",
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_REFRESH_REVOCATION_UNCONFIRMED",
    });
  });

  test("fails closed when no authoritative upstream is configured", async () => {
    await expect(
      revokeStewardRefreshToken("copied-refresh-token", {}),
    ).rejects.toMatchObject({
      code: "STEWARD_REFRESH_REVOCATION_UPSTREAM_MISSING",
    });
  });
});
