/**
 * Wallet-key migration helpers for `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY`.
 *
 * Storage layout (post-unification):
 *   - The shared vault is the source of truth. Keys are written at the
 *     bare `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` slots so the existing
 *     inventory categorizer (`categorizeKey`) surfaces them under
 *     Settings → Vault → Secrets in the "Wallet" group automatically.
 *   - The OS keystore (Keychain / libsecret) remains a one-shot read
 *     source for migrating off the legacy split-storage layout. We never
 *     write back into it from this module.
 *
 * Hydration (see `hydrate-wallet-keys-from-platform-store.ts`) reads the
 * vault first and copies the OS-keystore value across on the next boot
 * when the OS-keystore read path is enabled (default on supported desktops,
 * or explicitly via `ELIZA_WALLET_OS_STORE=1`).
 */

import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent";
import { ElizaError } from "@elizaos/core";
import { sharedVault } from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import type { SecureStoreSecretKind } from "./platform-secure-store";
import {
  createNodePlatformSecureStore,
  isNodePlatformSecureStoreSupported,
} from "./platform-secure-store-node";

const WALLET_PAIRS: ReadonlyArray<readonly [string, SecureStoreSecretKind]> = [
  ["EVM_PRIVATE_KEY", "wallet.evm_private_key"],
  ["SOLANA_PRIVATE_KEY", "wallet.solana_private_key"],
];

/**
 * Remove main wallet keys from BOTH the vault and the OS keystore.
 * Used by `POST /api/agent/reset` and the equivalent CLI flow.
 */
export async function deleteWalletSecretsFromOsStore(): Promise<void> {
  // A retained OS entry would be imported back into the vault at the next
  // boot, so secure-store cleanup must finish before the source-of-truth copy
  // is removed.
  if (isNodePlatformSecureStoreSupported()) {
    const store = createNodePlatformSecureStore();
    if (!(await store.isAvailable())) {
      throw new ElizaError(
        "OS secure store is unavailable during wallet reset",
        {
          code: "WALLET_RESET_SECURE_STORE_UNAVAILABLE",
          severity: "fatal",
        },
      );
    }
    const vaultId = deriveAgentVaultId();
    await store.delete(vaultId, "wallet.evm_private_key");
    await store.delete(vaultId, "wallet.solana_private_key");
  }

  const vault = sharedVault();
  for (const [envKey] of WALLET_PAIRS) {
    if (await vault.has(envKey)) await vault.remove(envKey);
  }
}

export type MigrateWalletPrivateKeysToOsStoreResult = {
  migrated: string[];
  failed: string[];
};

/**
 * Copies wallet keys from `process.env` and/or persisted `config.env` into
 * the shared vault, strips them from saved config, and ensures
 * `process.env` holds the values for the running process.
 *
 * Idempotent: if the vault already holds a key, the env value (if any)
 * is left in place but not re-written to the vault.
 */
export async function migrateWalletPrivateKeysToOsStore(): Promise<MigrateWalletPrivateKeysToOsStoreResult> {
  const vault = sharedVault();
  const migrated: string[] = [];
  const failed: string[] = [];

  const config = loadElizaConfig();
  const persisted =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};

  for (const [envKey] of WALLET_PAIRS) {
    const fromProcess =
      typeof process.env[envKey] === "string"
        ? process.env[envKey]?.trim()
        : "";
    const fromConfig =
      typeof persisted[envKey] === "string"
        ? String(persisted[envKey]).trim()
        : "";
    const value = fromProcess || fromConfig;
    if (!value) {
      continue;
    }

    if (await vault.has(envKey)) {
      // Already migrated — don't overwrite a vault entry that may have
      // been rotated since.
      continue;
    }

    try {
      await vault.set(envKey, value, {
        sensitive: true,
        caller: "wallet-migrate",
      });
      migrated.push(envKey);
    } catch (err) {
      // error-policy:J2 Preserve the vault failure with the affected logical slot.
      failed.push(envKey);
      throw new ElizaError(`vault write failed for ${envKey}`, {
        code: "WALLET_VAULT_WRITE_FAILED",
        cause: err,
        context: { envKey },
        severity: "fatal",
      });
    }

    if (!fromProcess) {
      process.env[envKey] = value;
    }
  }

  let dirty = false;
  const nextEnv = { ...persisted };
  for (const [envKey] of WALLET_PAIRS) {
    if (typeof nextEnv[envKey] === "string") {
      delete nextEnv[envKey];
      dirty = true;
    }
  }

  if (dirty) {
    if (Object.keys(nextEnv).length === 0) {
      delete config.env;
    } else {
      config.env = nextEnv as typeof config.env;
    }
    saveElizaConfig(config);
  }

  return { migrated, failed };
}
