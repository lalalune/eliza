/**
 * Enforces the managed Cloud execution-tier boundary for clock-driven
 * triggers. Both chat actions and the task worker consume this policy so a
 * scale-to-zero runtime cannot arm new timers or fire historical timer rows.
 */
import type { IAgentRuntime, TriggerType } from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared";

export const CLOUD_PROVISIONED_SETTING = "ELIZA_CLOUD_PROVISIONED";
export const CLOUD_EXECUTION_TIER_SETTING = "ELIZA_CLOUD_EXECUTION_TIER";
export const DEDICATED_LAZY_EXECUTION_TIER = "dedicated-lazy";
export const DEDICATED_ALWAYS_EXECUTION_TIER = "dedicated-always";
export const ALWAYS_ON_REQUIRED_MESSAGE =
  "Scheduled workflows require an always-on agent runtime. Confirm continuous billing before activating this workflow.";

function runtimeSetting(runtime: IAgentRuntime, key: string): unknown {
  const value = runtime.getSetting?.(key);
  return value === null || value === undefined || value === ""
    ? readAliasedEnv(key)
    : value;
}

function isEnabled(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === "string" &&
      ["1", "true"].includes(value.trim().toLowerCase()))
  );
}

export function isManagedCloudRuntime(runtime: IAgentRuntime): boolean {
  return (
    isEnabled(runtime.getSetting?.(CLOUD_PROVISIONED_SETTING)) ||
    isEnabled(readAliasedEnv(CLOUD_PROVISIONED_SETTING))
  );
}

export function isTimeBasedTriggerType(triggerType: TriggerType): boolean {
  return (
    triggerType === "once" ||
    triggerType === "interval" ||
    triggerType === "cron"
  );
}

export function isManagedCloudDedicatedLazy(runtime: IAgentRuntime): boolean {
  const executionTier = runtimeSetting(runtime, CLOUD_EXECUTION_TIER_SETTING);
  return (
    isManagedCloudRuntime(runtime) &&
    typeof executionTier === "string" &&
    executionTier.trim().toLowerCase() === DEDICATED_LAZY_EXECUTION_TIER
  );
}

export function activeTriggerRequiresAlwaysOn(
  runtime: IAgentRuntime,
  trigger: Pick<
    { enabled: boolean; triggerType: TriggerType },
    "enabled" | "triggerType"
  >,
): boolean {
  return (
    trigger.enabled &&
    isTimeBasedTriggerType(trigger.triggerType) &&
    isManagedCloudDedicatedLazy(runtime)
  );
}

export function alwaysOnRequiredContract(): Record<string, unknown> & {
  success: false;
  code: "workflow_requires_always_on";
  error: string;
} {
  return {
    success: false,
    code: "workflow_requires_always_on",
    error: ALWAYS_ON_REQUIRED_MESSAGE,
    capability: "scheduled_workflows",
    currentExecutionTier: DEDICATED_LAZY_EXECUTION_TIER,
    requiredExecutionTier: DEDICATED_ALWAYS_EXECUTION_TIER,
    upgradeRequired: true,
    upgrade: {
      automatic: false,
      available: true,
      requiresContinuousBillingConfirmation: true,
    },
  };
}
