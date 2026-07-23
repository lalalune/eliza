/**
 * Canonical completion policy for app setup. Managed Cloud deployment state is
 * runtime metadata, while every other setup path must be evidenced by config.
 */

import { readAliasedEnv } from "@elizaos/shared";
import {
  normalizeFirstRunProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared/contracts/first-run-options";
import type { ElizaConfig } from "../config/config.ts";

export function hasPersistedFirstRunState(config: ElizaConfig): boolean {
  if (config.meta?.firstRunComplete === true) {
    return true;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = normalizeFirstRunProviderId(llmText?.backend);
  const remoteApiBase =
    llmText?.remoteApiBase?.trim() ?? deploymentTarget.remoteApiBase?.trim();
  const hasCompleteCanonicalRouting =
    (llmText?.transport === "direct" &&
      Boolean(backend && backend !== "elizacloud")) ||
    (llmText?.transport === "remote" && Boolean(remoteApiBase)) ||
    (llmText?.transport === "cloud-proxy" &&
      backend === "elizacloud" &&
      Boolean(llmText.smallModel?.trim() && llmText.largeModel?.trim())) ||
    (deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase?.trim()));

  if (hasCompleteCanonicalRouting) {
    return true;
  }

  const agents = config.agents;
  if (!agents) {
    return false;
  }

  if (Array.isArray(agents.list) && agents.list.length > 0) {
    return true;
  }

  return Boolean(
    agents.defaults?.workspace?.trim() ||
      agents.defaults?.adminEntityId?.trim(),
  );
}

/**
 * Resolve the app-level setup state seen by a running agent.
 *
 * The bare managed-container marker is sufficient here because this predicate
 * controls onboarding lifecycle, not request authorization. Auth boundaries
 * continue to require the stronger provisioned-container credential check.
 */
export function isAppFirstRunComplete(config: ElizaConfig): boolean {
  return (
    readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1" ||
    hasPersistedFirstRunState(config)
  );
}
