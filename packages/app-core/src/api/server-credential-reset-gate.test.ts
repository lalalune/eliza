/**
 * Exercises the real HTTP wrapper to prove reset drains an accepted mutating
 * request and rejects later writers until destructive cleanup has finished.
 */

import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withCredentialStateReset } from "../security/credential-state-lock";
import {
  patchHttpCreateServerForCompat,
  requestMayMutateCredentialState,
} from "./server";

function request(
  port: number,
  pathname: string,
  method = "POST",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        method,
        path: pathname,
        port,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

describe("HTTP credential reset gate", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("admits credential writers concurrently, drains both, and refuses a later writer", async () => {
    const restoreHttp = patchHttpCreateServerForCompat();
    cleanups.push(restoreHttp);

    const persisted = new Map<string, string>();
    let releaseWriters!: () => void;
    const writerPause = new Promise<void>((resolve) => {
      releaseWriters = resolve;
    });
    cleanups.push(() => releaseWriters());
    let enteredCount = 0;
    let markBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      markBothEntered = resolve;
    });
    const listener = vi.fn(
      async (request: http.IncomingMessage, response: http.ServerResponse) => {
        if (request.url?.startsWith("/api/test-credential-writer")) {
          enteredCount += 1;
          if (enteredCount === 2) markBothEntered();
          await writerPause;
          persisted.set(request.url, "accepted-before-reset");
        } else {
          persisted.set("late", "must-not-run");
        }
        response.statusCode = 200;
        response.end();
      },
    );
    const server = http.createServer(listener);
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test port");

    const firstResponse = request(
      address.port,
      "/api/test-credential-writer-one",
    );
    const secondResponse = request(
      address.port,
      "/api/test-credential-writer-two",
    );
    await bothEntered;
    const resetWork = vi.fn(async () => persisted.clear());
    const reset = withCredentialStateReset(resetWork);

    await expect(
      request(address.port, "/api/test-credential-late-writer"),
    ).resolves.toBe(503);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(resetWork).not.toHaveBeenCalled();

    releaseWriters();
    await expect(firstResponse).resolves.toBe(200);
    await expect(secondResponse).resolves.toBe(200);
    await reset;

    expect(resetWork).toHaveBeenCalledOnce();
    expect(persisted.size).toBe(0);
  });

  it("drains the stateful GET OAuth callback before reset", async () => {
    const restoreHttp = patchHttpCreateServerForCompat();
    cleanups.push(restoreHttp);
    let releaseCallback!: () => void;
    const callbackPause = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    cleanups.push(() => releaseCallback());
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const listener: http.RequestListener = async (_request, response) => {
      markEntered();
      await callbackPause;
      response.end();
    };
    const server = http.createServer(listener);
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test port");

    const callback = request(
      address.port,
      "/api/connectors/discord/oauth/callback?state=test",
      "GET",
    );
    await entered;
    const resetWork = vi.fn(async () => undefined);
    const reset = withCredentialStateReset(resetWork);
    expect(resetWork).not.toHaveBeenCalled();

    releaseCallback();
    await expect(callback).resolves.toBe(200);
    await reset;
    expect(resetWork).toHaveBeenCalledOnce();
  });

  it("leaves long-lived chat streams outside the credential drain", () => {
    expect(
      requestMayMutateCredentialState("POST", "/v1/chat/completions"),
    ).toBe(false);
    expect(
      requestMayMutateCredentialState("POST", "/api/agents/a/message"),
    ).toBe(false);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/accounts/openai-codex/oauth/status",
      ),
    ).toBe(true);
    expect(requestMayMutateCredentialState("GET", "/api/auth/me")).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/lifeops/connectors/health/strava/callback",
      ),
    ).toBe(true);
    expect(
      requestMayMutateCredentialState("GET", "/api/apps/feed/timeline"),
    ).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/setup/telegram-account/status",
      ),
    ).toBe(true);
    expect(requestMayMutateCredentialState("GET", "/api/discord/guilds")).toBe(
      true,
    );
    expect(
      requestMayMutateCredentialState("GET", "/api/discord/channels"),
    ).toBe(true);
    expect(requestMayMutateCredentialState("GET", "/api/discord/guilds/")).toBe(
      true,
    );
    expect(requestMayMutateCredentialState("GET", "/api/accounts")).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/secrets/manager/preferences",
      ),
    ).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/internal/account-pool/v1/health",
      ),
    ).toBe(true);
  });
});
