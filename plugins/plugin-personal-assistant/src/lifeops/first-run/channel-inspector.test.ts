/**
 * Honest first-run channel validation against the production channel inspector.
 * The harness uses the real in-memory channel and connector registries so the
 * onboarding picker observes the same connector status path used by scheduled
 * delivery, while keeping the individual connector probes deterministic.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChannelRegistry,
  registerDefaultChannelPack,
} from "../channels/index.js";
import type {
  ConnectorContribution,
  ConnectorStatus,
} from "../connectors/contract.js";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
} from "../connectors/registry.js";
import { installFirstRunChannelInspector } from "./channel-inspector.js";
import { validateChannel } from "./questions.js";

function stubContribution(
  kind: string,
  status: () => Promise<ConnectorStatus>,
): ConnectorContribution {
  return {
    kind,
    capabilities: [`${kind}.send`],
    modes: ["local"],
    describe: { label: kind },
    start: async () => {},
    disconnect: async () => {},
    verify: async () => true,
    status,
  };
}

function makeRuntime(): {
  runtime: IAgentRuntime;
  reportError: ReturnType<typeof vi.fn>;
} {
  const reportError = vi.fn();
  const runtime = { reportError } as unknown as IAgentRuntime;
  return { runtime, reportError };
}

function installInspector(runtime: IAgentRuntime): void {
  const channelRegistry = createChannelRegistry();
  registerDefaultChannelPack(channelRegistry, runtime);
  installFirstRunChannelInspector(runtime, channelRegistry);
}

function registerConnector(
  runtime: IAgentRuntime,
  contribution: ConnectorContribution,
): void {
  const registry = createConnectorRegistry();
  registry.register(contribution);
  registerConnectorRegistry(runtime, registry);
}

describe("installFirstRunChannelInspector", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats in-process notification channels as connected", async () => {
    const { runtime } = makeRuntime();
    installInspector(runtime);

    await expect(validateChannel("in_app", runtime)).resolves.toMatchObject({
      connection: "connected",
      connected: true,
      fallbackToInApp: false,
    });
    await expect(validateChannel("push", runtime)).resolves.toMatchObject({
      connection: "connected",
      connected: true,
      fallbackToInApp: false,
    });
  });

  it("reflects a connector that reports state=ok as connected", async () => {
    const { runtime } = makeRuntime();
    registerConnector(
      runtime,
      stubContribution("telegram", async () => ({
        state: "ok",
        observedAt: new Date().toISOString(),
      })),
    );
    installInspector(runtime);

    await expect(validateChannel("telegram", runtime)).resolves.toEqual({
      channel: "telegram",
      registered: true,
      connection: "connected",
      connected: true,
      fallbackToInApp: false,
    });
  });

  it("reflects a connector that reports state=disconnected", async () => {
    const { runtime } = makeRuntime();
    registerConnector(
      runtime,
      stubContribution("discord", async () => ({
        state: "disconnected",
        observedAt: new Date().toISOString(),
      })),
    );
    installInspector(runtime);

    const result = await validateChannel("discord", runtime);
    expect(result).toMatchObject({
      channel: "discord",
      registered: true,
      connection: "disconnected",
      connected: false,
      fallbackToInApp: true,
    });
    expect(result.warning).toMatch(/disconnected/);
  });

  it("answers unknown when a connector-backed channel has no registered connector", async () => {
    const { runtime } = makeRuntime();
    installInspector(runtime);

    const result = await validateChannel("imessage", runtime);
    expect(result).toMatchObject({
      channel: "imessage",
      registered: true,
      connection: "unknown",
      connected: false,
      fallbackToInApp: true,
    });
    expect(result.warning).toMatch(/couldn't be verified/);
  });

  it("answers unknown and reports the diagnostic when a status probe throws", async () => {
    const { runtime, reportError } = makeRuntime();
    registerConnector(
      runtime,
      stubContribution("telegram", async () => {
        throw new Error("bridge unreachable");
      }),
    );
    installInspector(runtime);

    await expect(validateChannel("telegram", runtime)).resolves.toMatchObject({
      connection: "unknown",
      connected: false,
      fallbackToInApp: true,
    });
    expect(reportError).toHaveBeenCalledWith(
      "FirstRunChannelInspector.status",
      expect.any(Error),
      expect.objectContaining({
        channel: "telegram",
        connectorKind: "telegram",
      }),
    );
  });

  it("maps a degraded connector to unknown", async () => {
    const { runtime } = makeRuntime();
    registerConnector(
      runtime,
      stubContribution("telegram", async () => ({
        state: "degraded",
        observedAt: new Date().toISOString(),
      })),
    );
    installInspector(runtime);

    await expect(validateChannel("telegram", runtime)).resolves.toMatchObject({
      connection: "unknown",
      connected: false,
      fallbackToInApp: true,
    });
  });
});
