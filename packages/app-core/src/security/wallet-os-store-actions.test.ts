/**
 * Verifies wallet reset ordering at the secure-store boundary. The harness
 * substitutes storage adapters so it can prove that supported-but-unavailable
 * platforms fail closed and that OS cleanup completes before vault deletion.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(),
  deriveVaultId: vi.fn(() => "eliza1-AbCdEf0123_-wXyZ"),
  events: [] as string[],
  isSupported: vi.fn(() => true),
  store: {
    delete: vi.fn(async (_vaultId: string, _kind: string) => undefined),
    isAvailable: vi.fn(async () => true),
  },
  vault: {
    has: vi.fn(async (_envKey: string) => true),
    remove: vi.fn(async (_envKey: string) => undefined),
  },
}));

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig: vi.fn(),
}));

vi.mock("../services/vault-mirror", () => ({
  sharedVault: () => mocks.vault,
}));

vi.mock("./agent-vault-id", () => ({
  deriveAgentVaultId: mocks.deriveVaultId,
}));

vi.mock("./platform-secure-store-node", () => ({
  createNodePlatformSecureStore: mocks.createStore,
  isNodePlatformSecureStoreSupported: mocks.isSupported,
}));

import { deleteWalletSecretsFromOsStore } from "./wallet-os-store-actions";

describe("deleteWalletSecretsFromOsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.createStore.mockReturnValue(mocks.store);
    mocks.isSupported.mockReturnValue(true);
    mocks.store.isAvailable.mockResolvedValue(true);
    mocks.store.delete.mockImplementation(async (_vaultId, kind: string) => {
      mocks.events.push(`os:${kind}`);
    });
    mocks.vault.has.mockImplementation(async (envKey: string) => {
      mocks.events.push(`vault-has:${envKey}`);
      return true;
    });
    mocks.vault.remove.mockImplementation(async (envKey: string) => {
      mocks.events.push(`vault-remove:${envKey}`);
    });
  });

  it("cleans every recoverable OS entry before removing vault keys", async () => {
    await deleteWalletSecretsFromOsStore();

    expect(mocks.events).toEqual([
      "os:wallet.evm_private_key",
      "os:wallet.solana_private_key",
      "vault-has:EVM_PRIVATE_KEY",
      "vault-remove:EVM_PRIVATE_KEY",
      "vault-has:SOLANA_PRIVATE_KEY",
      "vault-remove:SOLANA_PRIVATE_KEY",
    ]);
  });

  it("fails closed before vault deletion when a supported store is unavailable", async () => {
    mocks.store.isAvailable.mockResolvedValue(false);

    await expect(deleteWalletSecretsFromOsStore()).rejects.toThrow(
      "OS secure store is unavailable during wallet reset",
    );
    expect(mocks.vault.has).not.toHaveBeenCalled();
    expect(mocks.vault.remove).not.toHaveBeenCalled();
  });

  it("skips OS cleanup only on platforms without an adapter", async () => {
    mocks.isSupported.mockReturnValue(false);

    await deleteWalletSecretsFromOsStore();

    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([
      "vault-has:EVM_PRIVATE_KEY",
      "vault-remove:EVM_PRIVATE_KEY",
      "vault-has:SOLANA_PRIVATE_KEY",
      "vault-remove:SOLANA_PRIVATE_KEY",
    ]);
  });
});
