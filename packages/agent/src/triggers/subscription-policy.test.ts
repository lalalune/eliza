/** Verifies trigger tier policy precedence and aliased-environment fallback. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeTriggerRequiresAlwaysOn,
  isManagedCloudDedicatedLazy,
  isManagedCloudRuntime,
} from "./subscription-policy.ts";

const originalProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;
const originalTier = process.env.ELIZA_CLOUD_EXECUTION_TIER;

afterEach(() => {
  if (originalProvisioned === undefined)
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  else process.env.ELIZA_CLOUD_PROVISIONED = originalProvisioned;
  if (originalTier === undefined) delete process.env.ELIZA_CLOUD_EXECUTION_TIER;
  else process.env.ELIZA_CLOUD_EXECUTION_TIER = originalTier;
});

function runtime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as IAgentRuntime;
}

describe("trigger subscription policy", () => {
  it("falls back to managed Cloud environment settings", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_CLOUD_EXECUTION_TIER = "dedicated-lazy";

    expect(isManagedCloudDedicatedLazy(runtime())).toBe(true);
    expect(
      activeTriggerRequiresAlwaysOn(runtime(), {
        enabled: true,
        triggerType: "interval",
      }),
    ).toBe(true);
  });

  it('accepts "true" from the managed Cloud environment', () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "true";
    process.env.ELIZA_CLOUD_EXECUTION_TIER = "dedicated-lazy";

    expect(isManagedCloudRuntime(runtime())).toBe(true);
    expect(isManagedCloudDedicatedLazy(runtime())).toBe(true);
  });

  it("recognizes a runtime-setting-only managed Cloud runtime", () => {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_CLOUD_EXECUTION_TIER;
    const lazy = runtime({
      ELIZA_CLOUD_PROVISIONED: true,
      ELIZA_CLOUD_EXECUTION_TIER: "dedicated-lazy",
    });

    expect(isManagedCloudRuntime(lazy)).toBe(true);
    expect(isManagedCloudDedicatedLazy(lazy)).toBe(true);
  });

  it("prefers explicit runtime settings and permits dedicated-always", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_CLOUD_EXECUTION_TIER = "dedicated-lazy";
    const dedicated = runtime({
      ELIZA_CLOUD_PROVISIONED: true,
      ELIZA_CLOUD_EXECUTION_TIER: "dedicated-always",
    });

    expect(isManagedCloudDedicatedLazy(dedicated)).toBe(false);
  });

  it("permits disabled and event triggers on dedicated-lazy", () => {
    const lazy = runtime({
      ELIZA_CLOUD_PROVISIONED: "true",
      ELIZA_CLOUD_EXECUTION_TIER: "dedicated-lazy",
    });

    expect(
      activeTriggerRequiresAlwaysOn(lazy, {
        enabled: false,
        triggerType: "cron",
      }),
    ).toBe(false);
    expect(
      activeTriggerRequiresAlwaysOn(lazy, {
        enabled: true,
        triggerType: "event",
      }),
    ).toBe(false);
  });
});
