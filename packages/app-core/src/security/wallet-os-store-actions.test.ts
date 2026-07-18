/**
 * Verifies agent reset ordering at the secure-store boundary. The harness
 * substitutes storage adapters so it can prove that supported-but-unavailable
 * platforms fail closed and that OS cleanup completes before vault deletion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteAgentSecretsFromSecureStores } from "./wallet-os-store-actions";

const vaultKeys = new Set<string>();
const mocks = {
  createStore: vi.fn(),
  deleteMetadata: vi.fn(),
  deriveVaultId: vi.fn(() => "eliza1-AbCdEf0123_-wXyZ"),
  events: [] as string[],
  isSupported: vi.fn(() => true),
  resetWalletCache: vi.fn(),
  store: {
    delete: vi.fn(async (_vaultId: string, _kind: string) => undefined),
    isAvailable: vi.fn(async () => true),
  },
  vault: {
    has: vi.fn(async (key: string) => vaultKeys.has(key)),
    list: vi.fn(async () => [...vaultKeys]),
    remove: vi.fn(async (_envKey: string) => undefined),
  },
};

const options = {
  createStore: () => mocks.createStore(),
  deleteMetadata: () => mocks.deleteMetadata(),
  deriveVaultId: () => mocks.deriveVaultId(),
  isStoreSupported: () => mocks.isSupported(),
  resetWalletCache: () => mocks.resetWalletCache(),
  vault: mocks.vault,
};

const SECRET_ENV_KEYS = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_STEWARD_AGENT_ID",
] as const;

describe("deleteAgentSecretsFromSecureStores", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    vaultKeys.clear();
    for (const key of [
      "EVM_PRIVATE_KEY",
      "ELIZAOS_CLOUD_API_KEY",
      "providers.openai.api-key",
      "OPENAI_API_KEY.profile.work",
      "_meta.OPENAI_API_KEY",
      "agent.test.wallet.evm",
      "_routing.config",
    ]) {
      vaultKeys.add(key);
    }
    mocks.createStore.mockReturnValue(mocks.store);
    mocks.resetWalletCache.mockImplementation(() => {
      mocks.events.push("cache:reset");
    });
    mocks.deleteMetadata.mockImplementation(() => {
      mocks.events.push("metadata:steward");
    });
    mocks.isSupported.mockReturnValue(true);
    mocks.store.isAvailable.mockResolvedValue(true);
    mocks.store.delete.mockImplementation(async (_vaultId, kind: string) => {
      mocks.events.push(`os:${kind}`);
    });
    mocks.vault.has.mockImplementation(async (key: string) => {
      mocks.events.push(`vault-has:${key}`);
      return vaultKeys.has(key);
    });
    mocks.vault.list.mockImplementation(async () => {
      mocks.events.push("vault-list");
      return [...vaultKeys];
    });
    mocks.vault.remove.mockImplementation(async (key: string) => {
      mocks.events.push(`vault-remove:${key}`);
      vaultKeys.delete(key);
    });
    for (const key of SECRET_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = `test-${key}`;
    }
  });

  afterEach(() => {
    for (const key of SECRET_ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it("cleans every recoverable OS entry before removing vault keys", async () => {
    await deleteAgentSecretsFromSecureStores(options);

    expect(mocks.events).toEqual([
      "os:wallet.evm_private_key",
      "os:wallet.solana_private_key",
      "os:steward.api_url",
      "os:steward.tenant_id",
      "os:steward.agent_id",
      "os:steward.api_key",
      "os:steward.agent_token",
      "metadata:steward",
      "vault-list",
      "vault-remove:EVM_PRIVATE_KEY",
      "vault-remove:ELIZAOS_CLOUD_API_KEY",
      "vault-remove:providers.openai.api-key",
      "vault-remove:OPENAI_API_KEY.profile.work",
      "vault-remove:_meta.OPENAI_API_KEY",
      "vault-remove:agent.test.wallet.evm",
      "vault-remove:_routing.config",
      "vault-list",
      "cache:reset",
    ]);
    for (const key of SECRET_ENV_KEYS) expect(process.env[key]).toBeUndefined();
  });

  it("fails closed before vault deletion when a supported store is unavailable", async () => {
    mocks.store.isAvailable.mockResolvedValue(false);

    await expect(deleteAgentSecretsFromSecureStores(options)).rejects.toThrow(
      "OS secure store is unavailable during wallet reset",
    );
    expect(mocks.vault.has).not.toHaveBeenCalled();
    expect(mocks.vault.remove).not.toHaveBeenCalled();
    expect(mocks.deleteMetadata).not.toHaveBeenCalled();
    expect(mocks.resetWalletCache).not.toHaveBeenCalled();
    for (const key of SECRET_ENV_KEYS)
      expect(process.env[key]).toBe(`test-${key}`);
  });

  it("keeps vault and env state when persistent metadata deletion fails", async () => {
    mocks.deleteMetadata.mockImplementation(() => {
      throw new Error("metadata deletion failed");
    });

    await expect(deleteAgentSecretsFromSecureStores(options)).rejects.toThrow(
      "metadata deletion failed",
    );
    expect(mocks.events).toEqual([
      "os:wallet.evm_private_key",
      "os:wallet.solana_private_key",
      "os:steward.api_url",
      "os:steward.tenant_id",
      "os:steward.agent_id",
      "os:steward.api_key",
      "os:steward.agent_token",
    ]);
    expect(mocks.vault.has).not.toHaveBeenCalled();
    expect(mocks.vault.remove).not.toHaveBeenCalled();
    for (const key of SECRET_ENV_KEYS) {
      expect(process.env[key]).toBe(`test-${key}`);
    }
  });

  it("skips OS cleanup only on unsupported platforms", async () => {
    mocks.isSupported.mockReturnValue(false);

    await deleteAgentSecretsFromSecureStores(options);

    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([
      "metadata:steward",
      "vault-list",
      "vault-remove:EVM_PRIVATE_KEY",
      "vault-remove:ELIZAOS_CLOUD_API_KEY",
      "vault-remove:providers.openai.api-key",
      "vault-remove:OPENAI_API_KEY.profile.work",
      "vault-remove:_meta.OPENAI_API_KEY",
      "vault-remove:agent.test.wallet.evm",
      "vault-remove:_routing.config",
      "vault-list",
      "cache:reset",
    ]);
    for (const key of SECRET_ENV_KEYS) expect(process.env[key]).toBeUndefined();
  });

  it("fails closed when a vault entry remains after removal", async () => {
    mocks.vault.remove.mockImplementation(async (key: string) => {
      mocks.events.push(`vault-remove:${key}`);
      if (key !== "ELIZAOS_CLOUD_API_KEY") vaultKeys.delete(key);
    });

    await expect(
      deleteAgentSecretsFromSecureStores(options),
    ).rejects.toMatchObject({
      code: "WALLET_RESET_VAULT_DELETE_INCOMPLETE",
    });

    expect(
      mocks.events.filter((event) => event.startsWith("vault-remove:")),
    ).toEqual([
      "vault-remove:EVM_PRIVATE_KEY",
      "vault-remove:ELIZAOS_CLOUD_API_KEY",
      "vault-remove:providers.openai.api-key",
      "vault-remove:OPENAI_API_KEY.profile.work",
      "vault-remove:_meta.OPENAI_API_KEY",
      "vault-remove:agent.test.wallet.evm",
      "vault-remove:_routing.config",
    ]);
    expect(mocks.resetWalletCache).not.toHaveBeenCalled();
    for (const key of SECRET_ENV_KEYS) {
      expect(process.env[key]).toBe(`test-${key}`);
    }
  });
});
