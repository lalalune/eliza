/** Verifies plugin disposal invalidates pending and in-flight health OAuth work. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingHealthOAuthSessionsForAgent,
  completeHealthConnectorOAuth,
  deleteStoredHealthToken,
  readStoredHealthToken,
  refreshStoredHealthToken,
  startHealthConnectorOAuth,
} from "./health-oauth";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function tokenResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function oauthState(authUrl: string | null): string {
  if (!authUrl)
    throw new Error("OAuth start did not return an authorization URL");
  const state = new URL(authUrl).searchParams.get("state");
  if (!state) throw new Error("OAuth start did not return state");
  return state;
}

describe("health OAuth lifecycle reset", () => {
  const originalClientId = process.env.ELIZA_STRAVA_CLIENT_ID;
  const originalClientSecret = process.env.ELIZA_STRAVA_CLIENT_SECRET;
  const originalOAuthDir = process.env.ELIZA_OAUTH_DIR;
  let oauthDir = "";

  beforeEach(() => {
    oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-oauth-reset-"));
    process.env.ELIZA_OAUTH_DIR = oauthDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPendingHealthOAuthSessionsForAgent("agent-reset-test");
    fs.rmSync(oauthDir, { recursive: true, force: true });
    if (originalClientId === undefined)
      delete process.env.ELIZA_STRAVA_CLIENT_ID;
    else process.env.ELIZA_STRAVA_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) {
      delete process.env.ELIZA_STRAVA_CLIENT_SECRET;
    } else {
      process.env.ELIZA_STRAVA_CLIENT_SECRET = originalClientSecret;
    }
    if (originalOAuthDir === undefined) delete process.env.ELIZA_OAUTH_DIR;
    else process.env.ELIZA_OAUTH_DIR = originalOAuthDir;
  });

  it("rejects a callback after the owning agent is disposed", async () => {
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const started = startHealthConnectorOAuth({
      provider: "strava",
      agentId: "agent-reset-test",
      side: "owner",
      requestUrl: new URL("http://127.0.0.1:2138"),
    });
    const state = oauthState(started.authUrl);

    expect(clearPendingHealthOAuthSessionsForAgent("agent-reset-test")).toBe(1);

    await expect(
      completeHealthConnectorOAuth(
        new URL(
          `http://127.0.0.1:2138/api/lifeops/connectors/health/strava/callback?state=${state}&code=late`,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an in-flight callback before it can restore a token", async () => {
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const started = startHealthConnectorOAuth({
      provider: "strava",
      agentId: "agent-reset-test",
      side: "owner",
      requestUrl: new URL("http://127.0.0.1:2138"),
    });
    const state = oauthState(started.authUrl);
    const response = deferred<Response>();
    const entered = deferred<void>();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      entered.resolve(undefined);
      return response.promise;
    });

    const completion = completeHealthConnectorOAuth(
      new URL(
        `http://127.0.0.1:2138/api/lifeops/connectors/health/strava/callback?state=${state}&code=late`,
      ),
    );
    await entered.promise;
    clearPendingHealthOAuthSessionsForAgent("agent-reset-test");
    response.resolve(
      tokenResponse({ access_token: "resurrected", expires_in: 3600 }),
    );

    await expect(completion).rejects.toMatchObject({ status: 409 });
    expect(
      readStoredHealthToken("agent-reset-test/owner/local/strava.json"),
    ).toBeNull();
  });

  it("rejects an in-flight refresh before it can rewrite reset state", async () => {
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({
        access_token: "original",
        refresh_token: "refresh",
        expires_in: 0,
      }),
    );
    const started = startHealthConnectorOAuth({
      provider: "strava",
      agentId: "agent-reset-test",
      side: "owner",
      requestUrl: new URL("http://127.0.0.1:2138"),
    });
    const state = oauthState(started.authUrl);
    const completed = await completeHealthConnectorOAuth(
      new URL(
        `http://127.0.0.1:2138/api/lifeops/connectors/health/strava/callback?state=${state}&code=initial`,
      ),
    );

    const response = deferred<Response>();
    const entered = deferred<void>();
    fetchSpy.mockImplementation(() => {
      entered.resolve(undefined);
      return response.promise;
    });
    const refresh = refreshStoredHealthToken(completed.tokenRef);
    await entered.promise;
    clearPendingHealthOAuthSessionsForAgent("agent-reset-test");
    response.resolve(
      tokenResponse({ access_token: "resurrected", expires_in: 3600 }),
    );

    await expect(refresh).rejects.toMatchObject({ status: 409 });
    expect(readStoredHealthToken(completed.tokenRef)?.accessToken).toBe(
      "original",
    );
  });

  it("does not resurrect a credential deleted during an in-flight refresh", async () => {
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({
        access_token: "original",
        refresh_token: "refresh",
        expires_in: 0,
      }),
    );
    const started = startHealthConnectorOAuth({
      provider: "strava",
      agentId: "agent-reset-test",
      side: "owner",
      requestUrl: new URL("http://127.0.0.1:2138"),
    });
    const state = oauthState(started.authUrl);
    const completed = await completeHealthConnectorOAuth(
      new URL(
        `http://127.0.0.1:2138/api/lifeops/connectors/health/strava/callback?state=${state}&code=initial`,
      ),
    );

    const response = deferred<Response>();
    const entered = deferred<void>();
    const observed: { signal?: AbortSignal | null } = {};
    fetchSpy.mockImplementation((_input, init) => {
      observed.signal = init?.signal ?? null;
      entered.resolve(undefined);
      return response.promise;
    });
    const refresh = refreshStoredHealthToken(completed.tokenRef);
    await entered.promise;
    deleteStoredHealthToken(completed.tokenRef);
    expect(observed.signal?.aborted).toBe(true);
    response.resolve(
      tokenResponse({ access_token: "resurrected", expires_in: 3600 }),
    );

    await expect(refresh).rejects.toMatchObject({ status: 409 });
    expect(readStoredHealthToken(completed.tokenRef)).toBeNull();
  });

  it("rejects token references outside the credential store", () => {
    const outside = path.join(
      path.dirname(oauthDir),
      `${path.basename(oauthDir)}-outside-token`,
    );
    fs.writeFileSync(outside, "do-not-delete");
    const traversal = path.relative(
      path.join(oauthDir, "lifeops", "health"),
      outside,
    );

    expect(() => readStoredHealthToken(traversal)).toThrow(
      "outside the credential store",
    );
    expect(() => deleteStoredHealthToken(traversal)).toThrow(
      "outside the credential store",
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("do-not-delete");
    fs.rmSync(outside, { force: true });
  });
});
