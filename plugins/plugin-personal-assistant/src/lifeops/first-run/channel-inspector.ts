/**
 * Registry-backed channel inspector for first-run notification validation.
 * The first-run question parser owns the fallback behavior, while this module
 * adapts the runtime's channel and connector registries into the inspector
 * contract installed by the plugin composition root.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { ChannelRegistry } from "../channels/index.js";
import { getConnectorRegistry } from "../connectors/registry.js";
import type { ChannelConnectionState } from "./questions.js";
import { setRuntimeChannelInspector } from "./questions.js";

export function installFirstRunChannelInspector(
  runtime: IAgentRuntime,
  channelRegistry: ChannelRegistry,
): void {
  setRuntimeChannelInspector(runtime, {
    isRegistered(channel) {
      return channelRegistry.get(channel) !== null;
    },
    async connectionState(channel): Promise<ChannelConnectionState> {
      const contribution = channelRegistry.get(channel);
      if (contribution && !contribution.connectorKind) {
        return "connected";
      }
      const connectorKind = contribution?.connectorKind;
      if (!connectorKind) {
        return "unknown";
      }
      const connector = getConnectorRegistry(runtime)?.get(connectorKind);
      if (!connector) {
        return "unknown";
      }
      try {
        const status = await connector.status();
        if (status.state === "ok") return "connected";
        if (status.state === "disconnected") return "disconnected";
        return "unknown";
      } catch (error) {
        // error-policy:J7 first-run validation must surface probe failures without killing onboarding.
        runtime.reportError("FirstRunChannelInspector.status", error, {
          channel,
          connectorKind,
        });
        return "unknown";
      }
    },
  });
}
