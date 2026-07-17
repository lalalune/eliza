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

import {
  loadElizaConfig,
  resetStewardWalletCache,
  saveElizaConfig,
} from "@elizaos/agent";
import { ElizaError } from "@elizaos/core";
import { deletePersistedStewardCredentialsMetadata } from "../services/steward-credentials";
import {
  resetSharedVaultAfterDestructiveReset,
  sharedVault,
} from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import { withCredentialStateMutation } from "./credential-state-lock";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "./platform-secure-store";
import {
  createNodePlatformSecureStore,
  isNodePlatformSecureStoreSupported,
} from "./platform-secure-store-node";

const WALLET_PAIRS: ReadonlyArray<readonly [string, SecureStoreSecretKind]> = [
  ["EVM_PRIVATE_KEY", "wallet.evm_private_key"],
  ["SOLANA_PRIVATE_KEY", "wallet.solana_private_key"],
];

const STEWARD_PAIRS: ReadonlyArray<
  readonly [keyof NodeJS.ProcessEnv, SecureStoreSecretKind]
> = [
  ["STEWARD_API_URL", "steward.api_url"],
  ["STEWARD_TENANT_ID", "steward.tenant_id"],
  ["STEWARD_AGENT_ID", "steward.agent_id"],
  ["STEWARD_API_KEY", "steward.api_key"],
  ["STEWARD_AGENT_TOKEN", "steward.agent_token"],
];

interface AgentSecretDeletionOptions {
  createStore?: () => PlatformSecureStore;
  deleteMetadata?: () => void;
  deriveVaultId?: () => string;
  isStoreSupported?: () => boolean;
  resetWalletCache?: () => void;
  vault?: {
    destroy?(): Promise<void>;
    has(key: string): Promise<boolean>;
    list(prefix?: string): Promise<readonly string[]>;
    remove(key: string): Promise<void>;
  };
}

/**
 * Removes wallet and Steward credentials from every persistent store before
 * clearing their process environment mirrors. Used by destructive agent reset.
 */
export async function deleteAgentSecretsFromSecureStores(
  options: AgentSecretDeletionOptions = {},
): Promise<void> {
  // A retained OS entry would be imported back into the vault at the next
  // boot, so secure-store cleanup must finish before the source-of-truth copy
  // is removed.
  const isStoreSupported =
    options.isStoreSupported ?? isNodePlatformSecureStoreSupported;
  if (isStoreSupported()) {
    const store = (options.createStore ?? createNodePlatformSecureStore)();
    if (!(await store.isAvailable())) {
      throw new ElizaError(
        "OS secure store is unavailable during wallet reset",
        {
          code: "WALLET_RESET_SECURE_STORE_UNAVAILABLE",
          severity: "fatal",
        },
      );
    }
    const vaultId = (options.deriveVaultId ?? deriveAgentVaultId)();
    for (const [, kind] of [...WALLET_PAIRS, ...STEWARD_PAIRS]) {
      await store.delete(vaultId, kind);
    }
  }

  (options.deleteMetadata ?? deletePersistedStewardCredentialsMetadata)();
  const vault = options.vault ?? sharedVault();
  // Vault profiles, provider aliases, generated per-agent wallets, metadata,
  // and password-manager sessions all rehydrate state on boot. A destructive
  // agent reset therefore removes the whole user vault, not a key allow-list.
  if (vault.destroy) {
    await vault.destroy();
    if (!options.vault) resetSharedVaultAfterDestructiveReset();
  } else {
    for (const key of await vault.list()) {
      await vault.remove(key);
    }
    const remainingVaultKeys = await vault.list();
    if (remainingVaultKeys.length > 0) {
      throw new ElizaError("vault entries survived destructive reset", {
        code: "WALLET_RESET_VAULT_DELETE_INCOMPLETE",
        context: { remainingVaultKeys },
        severity: "fatal",
      });
    }
  }
  for (const [envKey] of [...WALLET_PAIRS, ...STEWARD_PAIRS]) {
    delete process.env[envKey];
  }
  delete process.env.ELIZA_STEWARD_AGENT_ID;
  (options.resetWalletCache ?? resetStewardWalletCache)();
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
  return withCredentialStateMutation(migrateWalletPrivateKeysToOsStoreUnlocked);
}

async function migrateWalletPrivateKeysToOsStoreUnlocked(): Promise<MigrateWalletPrivateKeysToOsStoreResult> {
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
