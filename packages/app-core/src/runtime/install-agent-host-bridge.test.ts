/**
 * Verifies installAgentHostBridge() swaps the agent host-bridge seam from its
 * no-op default to the app-core implementation, exposing real vault /
 * account-pool / shared-vault / build-variant / cloud-pair-route capabilities.
 * Drives the real host-bridge singleton (reset before and after) — no runtime
 * boot.
 */

import type http from "node:http";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  getAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installAgentHostBridge,
  isAgentHostBridgeInstalled,
} from "./install-agent-host-bridge";

type ResolveAuthorizedRouteRole =
  typeof import("../api/auth").resolveAuthorizedRouteRole;

const mocks = vi.hoisted(() => ({
  resolveAuthorizedRouteRole: vi.fn<ResolveAuthorizedRouteRole>(async () => ({
    ok: true,
    role: "OWNER",
    identityId: "owner-identity",
  })),
}));

vi.mock("../api/auth", () => ({
  resolveAuthorizedRouteRole: mocks.resolveAuthorizedRouteRole,
}));

function request(
  method: string,
  url: string,
  headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  return {
    method,
    url,
    headers: { host: "example.test:2138", ...headers },
  } as http.IncomingMessage;
}

describe("installAgentHostBridge", () => {
  beforeEach(() => {
    _resetAgentHostBridge();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetAgentHostBridge();
  });

  it("wires app-core host capabilities into the agent host-bridge seam", () => {
    expect(getAgentHostBridge()).toBe(defaultAgentHostBridge);

    installAgentHostBridge();

    expect(isAgentHostBridgeInstalled()).toBe(true);
    const bridge = getAgentHostBridge();
    // The app-core bridge replaces the no-op default with real implementations.
    expect(bridge).not.toBe(defaultAgentHostBridge);
    expect(typeof bridge.runVaultBootstrap).toBe("function");
    expect(typeof bridge.getDefaultAccountPool).toBe("function");
    expect(typeof bridge.getAccountPoolBrokerSnapshot).toBe("function");
    expect(typeof bridge.sharedVault).toBe("function");
    expect(typeof bridge.getBuildVariant).toBe("function");
    expect(typeof bridge.handleCloudPairRoute).toBe("function");
    expect(typeof bridge.resolveHttpRequestAuthorization).toBe("function");
  });

  it("enforces CSRF for inbox mutations and preserves legacy route compatibility", async () => {
    installAgentHostBridge();
    const resolver = getAgentHostBridge().resolveHttpRequestAuthorization;
    if (!resolver)
      throw new Error("host authorization resolver was not installed");
    const runtime = {} as AgentRuntime;

    await expect(
      resolver(request("POST", "/api/inbox/messages?agentId=one"), runtime),
    ).resolves.toMatchObject({
      ok: true,
      role: "OWNER",
      identityId: "owner-identity",
    });
    expect(mocks.resolveAuthorizedRouteRole).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ skipCsrf: false }),
    );

    await resolver(request("DELETE", "/api/inbox/chats/mute"), runtime);
    expect(mocks.resolveAuthorizedRouteRole).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ skipCsrf: false }),
    );

    await resolver(request("GET", "/api/inbox/messages"), runtime);
    expect(mocks.resolveAuthorizedRouteRole).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ skipCsrf: true }),
    );

    await resolver(request("POST", "/api/legacy-agent-mutation"), runtime);
    expect(mocks.resolveAuthorizedRouteRole).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ skipCsrf: true }),
    );
  });

  it("cannot bypass inbox CSRF with a scheme-relative request target", async () => {
    mocks.resolveAuthorizedRouteRole.mockImplementation(
      async (req, options) => {
        if (
          options.skipCsrf === false &&
          req.headers["x-eliza-csrf"] !== "valid-csrf"
        ) {
          return { ok: false, status: 403, reason: "csrf_required" } as const;
        }
        return {
          ok: true,
          role: "OWNER",
          identityId: "owner-identity",
        } as const;
      },
    );
    installAgentHostBridge();
    const resolver = getAgentHostBridge().resolveHttpRequestAuthorization;
    if (!resolver)
      throw new Error("host authorization resolver was not installed");
    const runtime = {} as AgentRuntime;
    const target = "//attacker.test/api/inbox/messages";

    await expect(
      resolver(
        request("POST", target, { cookie: "eliza_session=owner-session" }),
        runtime,
      ),
    ).resolves.toEqual({ ok: false, role: "NONE" });
    expect(mocks.resolveAuthorizedRouteRole).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ skipCsrf: false }),
    );

    await expect(
      resolver(
        request("POST", target, {
          cookie: "eliza_session=owner-session",
          "x-eliza-csrf": "valid-csrf",
        }),
        runtime,
      ),
    ).resolves.toMatchObject({ ok: true, role: "OWNER" });
  });
});
