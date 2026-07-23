/**
 * Deterministic coverage for the app setup predicate across persisted config
 * and managed-container runtime metadata.
 */

import { getBootConfig, setBootConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasPersistedFirstRunState,
  isAppFirstRunComplete,
} from "./first-run-completion.ts";

const savedBootConfig = getBootConfig();
const savedCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;
const savedBrandedCloudProvisioned = process.env.MILADY_CLOUD_PROVISIONED;

beforeEach(() => {
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.MILADY_CLOUD_PROVISIONED;
  setBootConfig({ ...savedBootConfig, envAliases: [] });
});

afterEach(() => {
  if (savedCloudProvisioned === undefined) {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  } else {
    process.env.ELIZA_CLOUD_PROVISIONED = savedCloudProvisioned;
  }
  if (savedBrandedCloudProvisioned === undefined) {
    delete process.env.MILADY_CLOUD_PROVISIONED;
  } else {
    process.env.MILADY_CLOUD_PROVISIONED = savedBrandedCloudProvisioned;
  }
  setBootConfig(savedBootConfig);
});

describe("isAppFirstRunComplete", () => {
  it("treats the managed runtime marker as complete without fabricated config", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const config = {};

    expect(hasPersistedFirstRunState(config)).toBe(false);
    expect(isAppFirstRunComplete(config)).toBe(true);
  });

  it("keeps an empty local config pending", () => {
    expect(isAppFirstRunComplete({})).toBe(false);
  });

  it("continues to recognize persisted setup without the managed marker", () => {
    expect(isAppFirstRunComplete({ meta: { firstRunComplete: true } })).toBe(
      true,
    );
  });

  it("resolves branded aliases through the immutable boot config", () => {
    setBootConfig({
      ...savedBootConfig,
      envAliases: [["MILADY_CLOUD_PROVISIONED", "ELIZA_CLOUD_PROVISIONED"]],
    });
    process.env.MILADY_CLOUD_PROVISIONED = "1";

    expect(isAppFirstRunComplete({})).toBe(true);
  });
});
