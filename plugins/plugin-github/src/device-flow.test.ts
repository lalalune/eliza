/**
 * Device-flow protocol unit tests (#15796). GitHub's two OAuth endpoints are
 * the only thing stubbed — the flow logic under test (state machine, interval
 * ownership, agent scoping, secret hygiene) is the real module.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearDeviceFlowsForAgent,
  clearDeviceFlowsForTest,
  DeviceFlowError,
  pollDeviceFlow,
  startDeviceFlow,
} from "./device-flow.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedRequest {
  url: string;
  body: string;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Scripted GitHub: first call answers device/code, later calls answer token polls. */
function scriptedGitHub(tokenResponses: (() => Response)[]): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let tokenCall = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url === DEVICE_CODE_URL) {
      return jsonResponse({
        device_code: "secret-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (url === ACCESS_TOKEN_URL) {
      const next =
        tokenResponses[Math.min(tokenCall, tokenResponses.length - 1)];
      tokenCall += 1;
      return next();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

afterEach(() => clearDeviceFlowsForTest());

describe("startDeviceFlow", () => {
  it("keeps the device code server-side and returns only the user-visible half", async () => {
    const { fetchImpl, requests } = scriptedGitHub([]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: {
        fetchImpl,
        now: () => 1_000,
        randomBytesImpl: (() => Buffer.from("opaque-flow-id")) as never,
      },
    });
    expect(started).toEqual({
      flowId: Buffer.from("opaque-flow-id").toString("base64url"),
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    expect(JSON.stringify(started)).not.toContain("secret-device-code");
    expect(requests[0].body).toContain("client_id=client-1");
  });

  it("maps a client-registration rejection to an owner-setup error (409)", async () => {
    const fetchImpl = (async () =>
      // GitHub answers 200 with an error body for an unknown client id.
      jsonResponse({ error: "device_flow_disabled" })) as typeof fetch;
    const err = await startDeviceFlow({
      clientId: "bad-client",
      agentKey: "agent-a",
      deps: { fetchImpl },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("owner_setup");
    expect((err as DeviceFlowError).status).toBe(409);
  });

  it("maps an unreachable GitHub to an upstream error (502)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const err = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("upstream");
    expect((err as DeviceFlowError).status).toBe(502);
  });

  it("maps a malformed device-code response to an upstream error", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        user_code: "ABCD",
        verification_uri: "x",
      })) as typeof fetch;
    const err = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("upstream");
  });

  it("does not create a flow when lifecycle cleanup wins an in-flight start", async () => {
    const response = deferred<Response>();
    const requestStarted = deferred<void>();
    let signal: AbortSignal | null = null;
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      signal = init?.signal ?? null;
      requestStarted.resolve();
      return response.promise;
    }) as typeof fetch;

    const starting = startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl },
    });
    await requestStarted.promise;
    clearDeviceFlowsForAgent("agent-a");
    expect(signal?.aborted).toBe(true);
    response.resolve(
      jsonResponse({
        device_code: "late-secret-device-code",
        user_code: "LATE-CODE",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );

    await expect(starting).rejects.toMatchObject({
      code: "unknown_flow",
      status: 404,
    });
  });
});

describe("pollDeviceFlow", () => {
  it("walks pending → complete, sends the device code only to GitHub, and consumes the flow", async () => {
    let nowMs = 1_000;
    const { fetchImpl, requests } = scriptedGitHub([
      () => jsonResponse({ error: "authorization_pending" }),
      () =>
        jsonResponse({
          access_token: "gho_live_token_value",
          token_type: "bearer",
          scope: "repo,read:user",
        }),
    ]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => nowMs },
    });

    const pending = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => nowMs },
    });
    expect(pending).toEqual({ status: "pending", retryAfterSeconds: 5 });

    // Re-polling before the interval elapses never hits GitHub.
    const early = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => nowMs + 1_000 },
    });
    expect(early.status).toBe("pending");
    expect(requests.filter((r) => r.url === ACCESS_TOKEN_URL)).toHaveLength(1);

    nowMs += 5_000;
    const completed = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => nowMs },
    });
    expect(completed).toEqual({
      status: "complete",
      token: "gho_live_token_value",
      scope: "repo,read:user",
    });
    const tokenPolls = requests.filter((r) => r.url === ACCESS_TOKEN_URL);
    expect(tokenPolls[0].body).toContain("device_code=secret-device-code");

    // The flow is consumed — a replayed poll cannot mint the token twice.
    await expect(
      pollDeviceFlow({
        flowId: started.flowId,
        agentKey: "agent-a",
        deps: { fetchImpl, now: () => nowMs },
      }),
    ).rejects.toMatchObject({ code: "unknown_flow", status: 404 });
  });

  it("slow_down raises the server-owned polling interval", async () => {
    let nowMs = 10_000;
    const { fetchImpl, requests } = scriptedGitHub([
      () => jsonResponse({ error: "slow_down" }),
    ]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => nowMs },
    });
    const slowed = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => nowMs },
    });
    expect(slowed).toEqual({ status: "pending", retryAfterSeconds: 10 });

    // The raised interval is enforced server-side: an eager client re-polling
    // 1s later is throttled locally without a GitHub request.
    nowMs += 1_000;
    const throttled = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => nowMs },
    });
    expect(throttled).toEqual({ status: "pending", retryAfterSeconds: 9 });
    expect(requests.filter((r) => r.url === ACCESS_TOKEN_URL)).toHaveLength(1);
  });

  it("access_denied resolves as a terminal denied outcome", async () => {
    const { fetchImpl } = scriptedGitHub([
      () => jsonResponse({ error: "access_denied" }),
    ]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    const denied = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    expect(denied).toEqual({ status: "denied" });
    await expect(
      pollDeviceFlow({
        flowId: started.flowId,
        agentKey: "agent-a",
        deps: { fetchImpl, now: () => 0 },
      }),
    ).rejects.toMatchObject({ code: "unknown_flow" });
  });

  it("expired_token resolves as a terminal expired outcome", async () => {
    const { fetchImpl } = scriptedGitHub([
      () => jsonResponse({ error: "expired_token" }),
    ]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    const expired = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    expect(expired).toEqual({ status: "expired" });
  });

  it("sweeps a flow whose ten-minute window lapsed before any grant", async () => {
    const { fetchImpl } = scriptedGitHub([]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    // 900s window from the stubbed device-code response.
    await expect(
      pollDeviceFlow({
        flowId: started.flowId,
        agentKey: "agent-a",
        deps: { fetchImpl, now: () => 900_001 },
      }),
    ).rejects.toMatchObject({ code: "unknown_flow", status: 404 });
  });

  it("scopes flows per agent: another agent's key cannot poll the flow", async () => {
    const { fetchImpl, requests } = scriptedGitHub([
      () => jsonResponse({ access_token: "gho_stolen", scope: "" }),
    ]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    await expect(
      pollDeviceFlow({
        flowId: started.flowId,
        agentKey: "agent-b",
        deps: { fetchImpl, now: () => 0 },
      }),
    ).rejects.toMatchObject({ code: "unknown_flow", status: 404 });
    // The cross-agent probe never reached GitHub.
    expect(requests.filter((r) => r.url === ACCESS_TOKEN_URL)).toHaveLength(0);

    // The rightful owner still completes.
    const completed = await pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    expect(completed.status).toBe("complete");
  });

  it("lifecycle cleanup invalidates only the stopped agent's pending grants", async () => {
    const { fetchImpl } = scriptedGitHub([
      () => jsonResponse({ access_token: "gho_agent_b", scope: "repo" }),
    ]);
    const flowA = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    const flowB = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-b",
      deps: { fetchImpl, now: () => 0 },
    });

    clearDeviceFlowsForAgent("agent-a");

    await expect(
      pollDeviceFlow({
        flowId: flowA.flowId,
        agentKey: "agent-a",
        deps: { fetchImpl, now: () => 0 },
      }),
    ).rejects.toMatchObject({ code: "unknown_flow", status: 404 });
    await expect(
      pollDeviceFlow({
        flowId: flowB.flowId,
        agentKey: "agent-b",
        deps: { fetchImpl, now: () => 0 },
      }),
    ).resolves.toMatchObject({ status: "complete", token: "gho_agent_b" });
  });

  it("does not return a token when lifecycle cleanup wins an in-flight poll", async () => {
    const tokenResponse = deferred<Response>();
    const pollStarted = deferred<void>();
    let pollSignal: AbortSignal | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === DEVICE_CODE_URL) {
        return jsonResponse({
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }
      pollSignal = init?.signal ?? null;
      pollStarted.resolve();
      return tokenResponse.promise;
    }) as typeof fetch;
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });

    const polling = pollDeviceFlow({
      flowId: started.flowId,
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    await pollStarted.promise;
    clearDeviceFlowsForAgent("agent-a");
    expect(pollSignal?.aborted).toBe(true);
    tokenResponse.resolve(
      jsonResponse({ access_token: "gho_late_token", scope: "repo" }),
    );

    await expect(polling).rejects.toMatchObject({
      code: "unknown_flow",
      status: 404,
    });
  });

  it("maps an unrecognized GitHub error code to a terminal upstream error", async () => {
    const { fetchImpl } = scriptedGitHub([
      () => jsonResponse({ error: "mystery_failure" }),
    ]);
    const started = await startDeviceFlow({
      clientId: "client-1",
      agentKey: "agent-a",
      deps: { fetchImpl, now: () => 0 },
    });
    await expect(
      pollDeviceFlow({
        flowId: started.flowId,
        agentKey: "agent-a",
        deps: { fetchImpl, now: () => 0 },
      }),
    ).rejects.toMatchObject({ code: "upstream", status: 502 });
  });
});
