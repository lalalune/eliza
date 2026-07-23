/**
 * Verifies that real first-run persistence boots LifeOps for a new owner while
 * preserving an explicit capability opt-out during onboarding replay.
 */

import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent";
import { afterEach, describe, expect, it } from "vitest";
import { useIsolatedConfigEnv } from "../../test/helpers/isolated-config";
import { persistFirstRunDefaults } from "./server-first-run-helpers";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function isolateConfig(): void {
  const isolated = useIsolatedConfigEnv("first-run-lifeops-");
  cleanups.push(isolated.restore);
}

describe("first-run LifeOps persistence", () => {
  it("enables the personal assistant for a new owner runtime", () => {
    isolateConfig();

    persistFirstRunDefaults({
      name: "New Owner",
      language: "en",
      presetId: "default",
    });

    expect(
      loadElizaConfig().plugins?.entries?.["personal-assistant"]?.enabled,
    ).toBe(true);
  });

  it("preserves an owner's explicit personal-assistant opt-out on replay", () => {
    isolateConfig();
    const config = loadElizaConfig();
    config.plugins = {
      entries: {
        "personal-assistant": { enabled: false },
      },
    };
    saveElizaConfig(config);

    persistFirstRunDefaults({
      name: "Returning Owner",
      language: "en",
      presetId: "default",
    });

    expect(
      loadElizaConfig().plugins?.entries?.["personal-assistant"]?.enabled,
    ).toBe(false);
  });
});
