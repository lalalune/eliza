/**
 * Install the app-core implementation of the agent host bridge.
 *
 * `@elizaos/app-core` is the host layer above `@elizaos/agent`; the agent
 * runtime consumes a small set of host capabilities (OS wallet-key hydration,
 * vault bootstrap/access, the account-pool singleton, build-variant flags, and
 * the cloud-SSO pair route) through the downward-injection seam defined in
 * `@elizaos/agent/runtime/host-bridge`. This module wires the real app-core
 * implementations into that seam so the agent never imports `@elizaos/app-core`
 * (breaking the former `agent ↔ app-core` cycle, #9626).
 *
 * Called once from the app-core boot funnel before the runtime starts.
 * Idempotent — repeated calls re-install the same bridge cheaply.
 */

import {
  type AgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { getBuildVariant, isStoreBuild } from "@elizaos/core";
import { getAccountPoolBrokerSnapshot } from "../api/account-pool-broker-routes";
import { resolveAuthorizedRouteRole } from "../api/auth";
import { handleCloudPairRoute } from "../api/cloud-pair-route";
import {
  captureWalletEnvBootBaseline,
  hydrateWalletKeysFromNodePlatformSecureStore,
} from "../security/hydrate-wallet-keys-from-platform-store";
import {
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
} from "../services/account-pool";
import { runVaultBootstrap } from "../services/vault-bootstrap";
import { sharedVault } from "../services/vault-mirror";

let installed = false;

const CSRF_PROTECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isInboxMutationRequest(
  req: Parameters<
    NonNullable<AgentHostBridge["resolveHttpRequestAuthorization"]>
  >[0],
): boolean {
  if (!CSRF_PROTECTED_METHODS.has((req.method ?? "GET").toUpperCase())) {
    return false;
  }
  // Match the agent dispatcher's URL semantics exactly. Raw prefix checks can
  // misclassify absolute-form or scheme-relative request targets even though
  // the dispatcher resolves both to the protected inbox pathname.
  const pathname = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  ).pathname;
  return pathname === "/api/inbox" || pathname.startsWith("/api/inbox/");
}

export function installAgentHostBridge(): void {
  const resolveHttpRequestAuthorization: NonNullable<
    AgentHostBridge["resolveHttpRequestAuthorization"]
  > = async (req, runtime) => {
    const resolved = await resolveAuthorizedRouteRole(req, {
      // Inbox writes carry app-core's cookie+CSRF contract because they can
      // select a connector identity and send externally. Unrelated agent-owned
      // legacy mutations retain their compatibility exception after the
      // server's strict Origin/CORS gate.
      skipCsrf: !isInboxMutationRequest(req),
      state: {
        current: runtime,
      },
    });
    return resolved.ok
      ? {
          ok: true,
          role: resolved.role,
          ...(resolved.identityId ? { identityId: resolved.identityId } : {}),
          ...(resolved.principal ? { principal: resolved.principal } : {}),
        }
      : { ok: false, role: "NONE" };
  };
  const bridge: AgentHostBridge = {
    captureWalletEnvBootBaseline,
    hydrateWalletKeysFromNodePlatformSecureStore,
    runVaultBootstrap,
    sharedVault,
    getDefaultAccountPool,
    getAccountPoolBrokerSnapshot,
    applyAccountPoolApiCredentials: (options) =>
      applyAccountPoolApiCredentials(options),
    startAccountPoolKeepAlive: () => startAccountPoolKeepAlive(),
    getBuildVariant,
    isStoreBuild,
    handleCloudPairRoute,
    resolveHttpRequestAuthorization,
    isHttpRequestAuthorized: async (req, runtime) =>
      (await resolveHttpRequestAuthorization(req, runtime)).ok,
  };
  setAgentHostBridge(bridge);
  installed = true;
}

/** Whether the app-core bridge has been installed in this process. */
export function isAgentHostBridgeInstalled(): boolean {
  return installed;
}
