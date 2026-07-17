/**
 * Verifies reset removes agent-hydrated process values while restoring the
 * launch environment that persisted configuration temporarily overrode.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPersistedFirstRunConfig } from "../api/provider-switch-config";
import { loadElizaConfig } from "./config";

describe("config process-env reset provenance", () => {
  const keys = [
    "ELIZA_STATE_DIR",
    "ELIZA_CONFIG_PATH",
    "ELIZA_PERSIST_CONFIG_PATH",
    "EXTERNAL_PLUGIN_KEY",
    "AGENT_ONLY_PLUGIN_KEY",
  ] as const;
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const roots: string[] = [];

  afterEach(() => {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("restores a parent-shell value and removes a config-only value", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-env-origin-"));
    roots.push(root);
    const configPath = path.join(root, "eliza.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        env: {
          vars: {
            EXTERNAL_PLUGIN_KEY: "persisted-override",
            AGENT_ONLY_PLUGIN_KEY: "persisted-only",
          },
        },
      }),
    );
    process.env.ELIZA_STATE_DIR = root;
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
    process.env.EXTERNAL_PLUGIN_KEY = "launch-value";
    delete process.env.AGENT_ONLY_PLUGIN_KEY;

    const config = loadElizaConfig();
    expect(process.env.EXTERNAL_PLUGIN_KEY).toBe("persisted-override");
    expect(process.env.AGENT_ONLY_PLUGIN_KEY).toBe("persisted-only");

    clearPersistedFirstRunConfig(config);

    expect(process.env.EXTERNAL_PLUGIN_KEY).toBe("launch-value");
    expect(process.env.AGENT_ONLY_PLUGIN_KEY).toBeUndefined();
  });
});
