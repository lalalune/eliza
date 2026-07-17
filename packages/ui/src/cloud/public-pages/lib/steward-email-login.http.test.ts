/**
 * Real loopback HTTP coverage for the Steward email adapter. The server exercises
 * native fetch, JSON transport, tenant propagation, and all three endpoint shapes.
 */

// @vitest-environment node

import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  pollStewardEmailSignInStatus,
  startStewardEmailLogin,
  verifyStewardEmailSignInCode,
} from "./steward-email-login";

it("drives the shared challenge through a real HTTP transport", async () => {
  const requests: Array<{ path: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url || "", body });

    response.setHeader("Content-Type", "application/json");
    if (request.url === "/auth/email/send") {
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            expiresAt: "2026-07-17T12:10:00.000Z",
            challengeId: "challenge-live-http",
            pollSecret: "poll-secret-live-http",
          },
        }),
      );
      return;
    }
    if (request.url === "/auth/email/status") {
      response.end(JSON.stringify({ ok: true, data: { status: "pending" } }));
      return;
    }
    if (request.url === "/auth/email/code/verify") {
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            token: "session-token-live-http",
            refreshToken: "refresh-token-live-http",
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Loopback HTTP server did not expose a TCP address.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const options = { baseUrl, tenantId: "elizacloud" };

    await expect(
      startStewardEmailLogin(options, "person@example.com"),
    ).resolves.toEqual({
      expiresAtMs: Date.parse("2026-07-17T12:10:00.000Z"),
      challengeId: "challenge-live-http",
      pollSecret: "poll-secret-live-http",
    });
    await expect(
      pollStewardEmailSignInStatus(
        options,
        "challenge-live-http",
        "poll-secret-live-http",
      ),
    ).resolves.toBe("pending");
    await expect(
      verifyStewardEmailSignInCode(options, "person@example.com", "123456"),
    ).resolves.toEqual({
      mfaRequired: false,
      token: "session-token-live-http",
      refreshToken: "refresh-token-live-http",
    });

    expect(requests).toEqual([
      {
        path: "/auth/email/send",
        body: JSON.stringify({
          email: "person@example.com",
          tenantId: "elizacloud",
        }),
      },
      {
        path: "/auth/email/status",
        body: JSON.stringify({
          challengeId: "challenge-live-http",
          pollSecret: "poll-secret-live-http",
          tenantId: "elizacloud",
        }),
      },
      {
        path: "/auth/email/code/verify",
        body: JSON.stringify({
          email: "person@example.com",
          code: "123456",
          tenantId: "elizacloud",
        }),
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
