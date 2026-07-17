/** Verifies boot hydration fails only when an enabled secure-store backend is unavailable. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  store: {
    backend: "none" as const,
    isAvailable: vi.fn(async () => false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  vault: {
    has: vi.fn(async (_key: string) => false),
    reveal: vi.fn(async (_key: string) => ""),
    set: vi.fn(
      async (_key: string, _value: string, _options?: unknown) => undefined,
    ),
  },
};

import {
  _resetWalletEnvBootBaselineForTest,
  hydrateWalletKeysFromNodePlatformSecureStore,
} from "./hydrate-wallet-keys-from-platform-store";

const HANDLED_ENV_KEYS = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_STEWARD_AGENT_ID",
] as const;

describe("wallet and steward secure-store hydration", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.isAvailable.mockResolvedValue(false);
    mocks.vault.has.mockResolvedValue(false);
    _resetWalletEnvBootBaselineForTest();
    for (const key of HANDLED_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of HANDLED_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("surfaces an enabled but unavailable backend", async () => {
    const hydration = hydrateWalletKeysFromNodePlatformSecureStore({
      readEnabled: true,
      secureStore: mocks.store,
      vault: mocks.vault,
    });

    await expect(hydration).rejects.toThrowError(
      expect.objectContaining({ code: "SECURE_STORE_READ_UNAVAILABLE" }),
    );
    expect(mocks.vault.has).toHaveBeenCalledTimes(2);
    expect(mocks.store.isAvailable).toHaveBeenCalled();
    expect(mocks.store.get).not.toHaveBeenCalled();
  });

  it("does not probe the backend when OS-store reads are disabled", async () => {
    await expect(
      hydrateWalletKeysFromNodePlatformSecureStore({
        readEnabled: false,
        secureStore: mocks.store,
        vault: mocks.vault,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.store.isAvailable).not.toHaveBeenCalled();
  });

  it("publishes wallet env only after the whole migration batch succeeds", async () => {
    const values = new Map<string, string>();
    let solanaFails = true;
    mocks.store.isAvailable.mockResolvedValue(true);
    mocks.store.get.mockImplementation(async (_vaultId, kind) => {
      if (kind === "wallet.evm_private_key") {
        return { ok: true, value: "evm-secret" };
      }
      if (kind === "wallet.solana_private_key") {
        return solanaFails
          ? { ok: false, reason: "error" }
          : { ok: true, value: "solana-secret" };
      }
      return { ok: false, reason: "not_found" };
    });
    mocks.vault.has.mockImplementation(async (key) => values.has(key));
    mocks.vault.reveal.mockImplementation(async (key) => values.get(key) ?? "");
    mocks.vault.set.mockImplementation(async (key, value) => {
      values.set(key, value);
    });

    await expect(
      hydrateWalletKeysFromNodePlatformSecureStore({
        readEnabled: true,
        secureStore: mocks.store,
        vault: mocks.vault,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "SECURE_STORE_READ_FAILED" }),
    );
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();

    solanaFails = false;
    await hydrateWalletKeysFromNodePlatformSecureStore({
      readEnabled: true,
      secureStore: mocks.store,
      vault: mocks.vault,
    });
    expect(process.env.EVM_PRIVATE_KEY).toBe("evm-secret");
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("solana-secret");
  });

  it("publishes no partial steward env when a later read fails", async () => {
    process.env.EVM_PRIVATE_KEY = "launch-evm";
    process.env.SOLANA_PRIVATE_KEY = "launch-solana";
    let tenantFails = true;
    mocks.store.isAvailable.mockResolvedValue(true);
    mocks.store.get.mockImplementation(async (_vaultId, kind) => {
      if (kind === "steward.api_url") {
        return { ok: true, value: "https://steward.local" };
      }
      if (kind === "steward.tenant_id" && tenantFails) {
        return { ok: false, reason: "denied" };
      }
      return { ok: false, reason: "not_found" };
    });

    await expect(
      hydrateWalletKeysFromNodePlatformSecureStore({
        readEnabled: true,
        secureStore: mocks.store,
        vault: mocks.vault,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "SECURE_STORE_READ_DENIED" }),
    );
    expect(process.env.STEWARD_API_URL).toBeUndefined();

    tenantFails = false;
    await hydrateWalletKeysFromNodePlatformSecureStore({
      readEnabled: true,
      secureStore: mocks.store,
      vault: mocks.vault,
    });
    expect(process.env.STEWARD_API_URL).toBe("https://steward.local");
  });

  it("does not probe the store for a complete launch-env auth tuple", async () => {
    process.env.EVM_PRIVATE_KEY = "launch-evm";
    process.env.SOLANA_PRIVATE_KEY = "launch-solana";
    process.env.STEWARD_API_URL = "https://steward.local";
    process.env.STEWARD_AGENT_TOKEN = "launch-token";

    await hydrateWalletKeysFromNodePlatformSecureStore({
      readEnabled: true,
      secureStore: mocks.store,
      vault: mocks.vault,
    });

    expect(mocks.store.isAvailable).not.toHaveBeenCalled();
    expect(mocks.store.get).not.toHaveBeenCalled();
  });

  it("accepts the launch agent-id alias with API-key auth", async () => {
    process.env.EVM_PRIVATE_KEY = "launch-evm";
    process.env.SOLANA_PRIVATE_KEY = "launch-solana";
    process.env.STEWARD_API_URL = "https://steward.local";
    process.env.ELIZA_STEWARD_AGENT_ID = "launch-agent";
    process.env.STEWARD_API_KEY = "launch-api-key";

    await hydrateWalletKeysFromNodePlatformSecureStore({
      readEnabled: true,
      secureStore: mocks.store,
      vault: mocks.vault,
    });

    expect(mocks.store.isAvailable).not.toHaveBeenCalled();
    expect(mocks.store.get).not.toHaveBeenCalled();
  });
});
