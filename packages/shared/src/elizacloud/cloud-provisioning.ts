/**
 * Pure env-var detector for platform-managed cloud containers. Lives in
 * `@elizaos/shared` so that `@elizaos/agent` (and other host-layer code) can
 * make this decision without dynamically importing `@elizaos/plugin-elizacloud`
 * at module scope — that pattern previously forced the cloud plugin to load
 * during container boot.
 */

import { readAliasedEnv } from "../utils/env.js";

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function hasCompatApiToken(): boolean {
  return hasValue(readAliasedEnv("ELIZA_API_TOKEN"));
}

function hasCloudApiKeyProvisioning(): boolean {
  return (
    isCloudFlagEnabled(readAliasedEnv("ELIZAOS_CLOUD_ENABLED")) &&
    hasValue(readAliasedEnv("ELIZAOS_CLOUD_API_KEY"))
  );
}

/** Parse the two supported spellings for Cloud topology flags. */
export function isCloudFlagEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/** Whether the alias-resolved provisioning flag marks this process as managed. */
export function isCloudProvisionedEnvironment(): boolean {
  return isCloudFlagEnabled(readAliasedEnv("ELIZA_CLOUD_PROVISIONED"));
}

export function isCloudProvisionedContainer(): boolean {
  return (
    isCloudProvisionedEnvironment() &&
    (hasValue(process.env.STEWARD_AGENT_TOKEN) ||
      hasCompatApiToken() ||
      hasCloudApiKeyProvisioning())
  );
}
