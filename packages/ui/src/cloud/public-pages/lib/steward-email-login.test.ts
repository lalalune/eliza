/**
 * Direct Steward email sign-in adapter coverage. These tests pin the HTTP
 * contract separately from the React login surface so SDK drift cannot hide a
 * broken path, and status polling remains session-free.
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  pollStewardEmailSignInStatus,
  startStewardEmailLogin,
  verifyStewardEmailSignInCode,
} from "./steward-email-login";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("steward email sign-in adapter", () => {
  it("starts an email login challenge through /auth/email/send", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          expiresAt: "2026-07-17T12:10:00.000Z",
          challengeId: "challenge-1",
          pollSecret: "poll-secret",
        },
      }),
    );

    await expect(
      startStewardEmailLogin(
        {
          baseUrl: "https://api.example.test/steward",
          tenantId: "elizacloud",
          fetchImpl,
        },
        "person@example.com",
      ),
    ).resolves.toEqual({
      expiresAtMs: Date.parse("2026-07-17T12:10:00.000Z"),
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/steward/auth/email/send",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "person@example.com",
          tenantId: "elizacloud",
        }),
      }),
    );
  });

  it("preserves magic-link-only login during a rolling Steward deployment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { expiresAt: "2026-07-17T12:10:00.000Z" },
      }),
    );

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).resolves.toEqual({
      expiresAtMs: Date.parse("2026-07-17T12:10:00.000Z"),
    });
  });

  it("verifies a six-digit companion code and returns the Steward session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { token: "session-token", refreshToken: "refresh-token" },
      }),
    );

    await expect(
      verifyStewardEmailSignInCode(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
        "123456",
      ),
    ).resolves.toEqual({
      mfaRequired: false,
      token: "session-token",
      refreshToken: "refresh-token",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/steward/auth/email/code/verify",
      expect.objectContaining({
        body: JSON.stringify({
          email: "person@example.com",
          code: "123456",
          tenantId: "elizacloud",
        }),
      }),
    );
  });

  it("polls status without returning a session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, data: { status: "consumed" } }),
      );

    await expect(
      pollStewardEmailSignInStatus(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "challenge-1",
        "poll-secret",
      ),
    ).resolves.toBe("consumed");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/steward/auth/email/status",
      expect.objectContaining({
        body: JSON.stringify({
          challengeId: "challenge-1",
          pollSecret: "poll-secret",
          tenantId: "elizacloud",
        }),
      }),
    );
  });

  it("surfaces honest rate-limit failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: "Too many email attempts.", code: "rate_limited" },
          429,
        ),
      );

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "STEWARD_EMAIL_LOGIN_HTTP_FAILED",
      upstreamCode: "rate_limited",
      message: "Too many email attempts.",
    });
  });

  it("rejects partial polling credentials instead of silently downgrading", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          expiresAt: "2026-07-17T12:10:00.000Z",
          challengeId: "challenge-1",
        },
      }),
    );

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "STEWARD_EMAIL_LOGIN_RESPONSE_INVALID",
      message: "Steward email sign-in returned incomplete polling credentials.",
    });
  });

  it.each([
    ["an empty expiry", ""],
    ["an invalid date", "not-a-date"],
    ["a non-finite number", Number.NaN],
    ["a negative timestamp", -1],
  ])("rejects %s", async (_label, expiresAt) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, data: { expiresAt } }));

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "STEWARD_EMAIL_LOGIN_RESPONSE_INVALID",
    });
  });

  it("rejects a successful verification payload without a session token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, data: { refreshToken: "refresh-token" } }),
      );

    await expect(
      verifyStewardEmailSignInCode(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
        "123456",
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "STEWARD_EMAIL_LOGIN_RESPONSE_INVALID",
      message:
        "Steward email sign-in returned an authenticated response without a token.",
    });
  });

  it("preserves an explicit MFA-required result without inventing a session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, data: { mfaRequired: true } }),
      );

    await expect(
      verifyStewardEmailSignInCode(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
        "123456",
      ),
    ).resolves.toEqual({ mfaRequired: true });
  });

  it("rejects malformed JSON with the response status and parse cause", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "STEWARD_EMAIL_LOGIN_RESPONSE_INVALID",
      cause: expect.any(Error),
    });
  });

  it("wraps transport failures without losing their cause", async () => {
    const cause = new TypeError("connection reset");
    const fetchImpl = vi.fn().mockRejectedValue(cause);

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).rejects.toMatchObject({
      status: 0,
      code: "STEWARD_EMAIL_LOGIN_TRANSPORT_FAILED",
      cause,
    });
  });

  it("forwards cancellation to the underlying request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = startStewardEmailLogin(
      {
        baseUrl: "/steward",
        tenantId: "elizacloud",
        fetchImpl,
        signal: controller.signal,
      },
      "person@example.com",
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      status: 0,
      code: "STEWARD_EMAIL_LOGIN_TRANSPORT_FAILED",
      cause: expect.objectContaining({ name: "AbortError" }),
    });
  });
});
