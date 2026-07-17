/**
 * Verifies account-pool environment overlays are removed without disturbing
 * launch-time or independently replaced provider configuration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetAccountAuthWritesForTests,
  saveAccount,
} from "@elizaos/auth/account-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAccountPoolApiCredentials,
  closeAccountPoolForCredentialReset,
} from "./account-pool";

const ENVIRONMENT_KEYS = [
  "ELIZA_HOME",
  "ELIZA_STATE_DIR",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

describe("account-pool destructive reset", () => {
  let root = "";
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(() => {
    closeAccountPoolForCredentialReset();
    __resetAccountAuthWritesForTests();
    previousEnvironment = Object.fromEntries(
      ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
    );
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-account-pool-reset-"));
    process.env.ELIZA_HOME = root;
    process.env.ELIZA_STATE_DIR = path.join(root, "state");
    process.env.MOONSHOT_API_KEY = "launch-moonshot";
    process.env.OPENAI_API_KEY = "launch-openai";
    process.env.OPENAI_BASE_URL = "https://launch.example/v1";

    const now = Date.now();
    saveAccount({
      id: "primary",
      providerId: "moonshot-api",
      label: "Primary",
      source: "api-key",
      credentials: {
        access: "pool-moonshot",
        refresh: "",
        expires: now + 60_000,
      },
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    closeAccountPoolForCredentialReset();
    __resetAccountAuthWritesForTests();
    fs.rmSync(root, { force: true, recursive: true });
    for (const key of ENVIRONMENT_KEYS) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("restores launch-time values after clearing pool-owned credentials", async () => {
    await applyAccountPoolApiCredentials({ activeBackend: "moonshot" });

    expect(process.env.MOONSHOT_API_KEY).toBe("pool-moonshot");
    expect(process.env.OPENAI_API_KEY).toBe("pool-moonshot");
    expect(process.env.OPENAI_BASE_URL).toBe("https://api.moonshot.ai/v1");

    closeAccountPoolForCredentialReset();

    expect(process.env.MOONSHOT_API_KEY).toBe("launch-moonshot");
    expect(process.env.OPENAI_API_KEY).toBe("launch-openai");
    expect(process.env.OPENAI_BASE_URL).toBe("https://launch.example/v1");
  });

  it("does not overwrite a value replaced after account-pool injection", async () => {
    await applyAccountPoolApiCredentials({ activeBackend: "moonshot" });
    process.env.OPENAI_API_KEY = "independent-replacement";

    closeAccountPoolForCredentialReset();

    expect(process.env.OPENAI_API_KEY).toBe("independent-replacement");
    expect(process.env.MOONSHOT_API_KEY).toBe("launch-moonshot");
    expect(process.env.OPENAI_BASE_URL).toBe("https://launch.example/v1");
  });

  it("deletes pool-owned environment values that had no launch baseline", async () => {
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    await applyAccountPoolApiCredentials({ activeBackend: "moonshot" });

    closeAccountPoolForCredentialReset();

    expect(process.env.MOONSHOT_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });
});
