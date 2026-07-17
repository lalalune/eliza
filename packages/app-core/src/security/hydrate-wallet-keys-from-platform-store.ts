/**
 * Boot-time hydration of wallet (and steward) secrets into `process.env`.
 * Wallet keys are read from the shared vault (now the source of truth), with a
 * one-shot migration of any legacy values still only in the OS keystore;
 * steward env vars stay on the OS-keystore path because that backend's
 * lifecycle is independent of the unified vault.
 *
 * Precedence contract: launch env > vault/OS-keystore > persisted config.
 * app-core's `startApiServer` still calls this before it merges `config.env`,
 * where the contract holds by ordering alone; the agent boot path instead
 * defers the hydrate to the post-ready wave and captures a pre-merge baseline
 * (`captureWalletEnvBootBaseline`) so the same precedence holds there too.
 */
import { ElizaError, logger } from "@elizaos/core";

import { hasCompleteStewardEnvironment } from "../services/steward-credentials";
import { sharedVault } from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import { withCredentialStateMutation } from "./credential-state-lock";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "./platform-secure-store";
import {
  createNodePlatformSecureStore,
  isWalletOsStoreReadEnabled,
} from "./platform-secure-store-node";
import { secureStoreValueOrMissing } from "./secure-store-read";

interface WalletHydrationVault {
  has(key: string): Promise<boolean>;
  reveal(key: string, caller: string): Promise<string>;
  set(
    key: string,
    value: string,
    options: { sensitive: boolean; caller: string },
  ): Promise<unknown>;
}

// TDZ-hardening (see also packages/app-core/src/services/vault-mirror.ts).
// These module-top `const` literals are referenced inside async functions
// that run on the boot path. If a circular import (e.g. vault-bootstrap →
// agent → app-core → … → this module) re-enters those functions before this
// file's top-level initializers complete, Bun's strict ESM throws
// `Cannot access 'WALLET_VAULT_KEYS' before initialization`. Wrapping the
// arrays in functions makes them callable regardless of init order — the
// array literal builds when the getter is invoked, not at module top.
function walletVaultKeys(): ReadonlyArray<keyof NodeJS.ProcessEnv> {
  return ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"];
}

/**
 * Steward-only env vars (non-wallet) that still ride the OS keystore. They
 * never moved into the unified vault because the steward backend has its
 * own auth model — leave them on the keystore-only path.
 */
function stewardOsPairs(): ReadonlyArray<
  readonly [keyof NodeJS.ProcessEnv, SecureStoreSecretKind]
> {
  return [
    ["STEWARD_API_URL", "steward.api_url"],
    ["STEWARD_TENANT_ID", "steward.tenant_id"],
    ["STEWARD_AGENT_ID", "steward.agent_id"],
    ["STEWARD_API_KEY", "steward.api_key"],
    ["STEWARD_AGENT_TOKEN", "steward.agent_token"],
  ];
}

function stewardLaunchEnvKeys(): ReadonlyArray<keyof NodeJS.ProcessEnv> {
  return [
    ...stewardOsPairs().map(([envKey]) => envKey),
    "ELIZA_STEWARD_AGENT_ID",
  ];
}

// The hydrate used to run BEFORE config.env merged into process.env, so its
// "skip keys that already have a value" check naturally meant "skip keys the
// LAUNCH ENV set" — vault/keystore values beat persisted config, launch env
// beat both. Now that the agent boot defers the hydrate (it runs after the
// merge), the baseline preserves that exact precedence: the boot path records
// which handled keys the launch env set pre-merge, and `hasLaunchEnvValue`
// treats a post-merge value on a key absent from the baseline as
// overwritable. With no baseline captured (callers that still hydrate
// pre-merge, e.g. app-core's startApiServer), any present value is respected —
// the original semantics.
let walletEnvBootBaseline: ReadonlySet<string> | null = null;

/** Record which wallet/steward env keys currently hold values (pre-merge). */
export function captureWalletEnvBootBaseline(): void {
  const withValue = new Set<string>();
  for (const envKey of walletVaultKeys()) {
    if (process.env[envKey]?.trim()) withValue.add(String(envKey));
  }
  for (const envKey of stewardLaunchEnvKeys()) {
    if (process.env[envKey]?.trim()) withValue.add(String(envKey));
  }
  walletEnvBootBaseline = withValue;
}

/** Test-only: drop the captured baseline (pre-merge semantics resume). */
export function _resetWalletEnvBootBaselineForTest(): void {
  walletEnvBootBaseline = null;
}

/**
 * True when `envKey`'s current process.env value must be respected: it either
 * predates the config merge (present in the captured baseline) or no baseline
 * was captured at all.
 */
function hasLaunchEnvValue(envKey: keyof NodeJS.ProcessEnv): boolean {
  const cur = process.env[envKey];
  if (typeof cur !== "string" || !cur.trim()) return false;
  return walletEnvBootBaseline === null
    ? true
    : walletEnvBootBaseline.has(String(envKey));
}

/**
 * One-shot copy of legacy OS-keystore wallet keys into the shared vault.
 * Returns the env keys that were copied across so the caller can log /
 * surface a migration banner.
 */
async function migrateOsStoreWalletKeysIntoVault(
  envKeys: ReadonlyArray<keyof NodeJS.ProcessEnv>,
  options: {
    readEnabled: boolean;
    store: PlatformSecureStore;
    vault: WalletHydrationVault;
  },
): Promise<{
  migrated: string[];
  values: Array<readonly [keyof NodeJS.ProcessEnv, string]>;
}> {
  if (envKeys.length === 0 || !options.readEnabled) {
    return { migrated: [], values: [] };
  }

  const { store, vault } = options;
  if (!(await store.isAvailable())) {
    throw new ElizaError(
      "wallet secure store is unavailable during migration",
      {
        code: "SECURE_STORE_READ_UNAVAILABLE",
        context: { operation: "wallet-os-store-migrate" },
        severity: "fatal",
      },
    );
  }
  const vaultId = deriveAgentVaultId();
  const keychainKindFor: Record<string, SecureStoreSecretKind> = {
    EVM_PRIVATE_KEY: "wallet.evm_private_key",
    SOLANA_PRIVATE_KEY: "wallet.solana_private_key",
  };
  const migrated: string[] = [];
  const values: Array<readonly [keyof NodeJS.ProcessEnv, string]> = [];

  for (const envKey of envKeys) {
    const kind = keychainKindFor[envKey as string];
    if (!kind) continue;
    const got = await store.get(vaultId, kind);
    const value = secureStoreValueOrMissing(got, {
      kind,
      operation: "wallet-os-store-migrate",
    });
    if (value === null) continue;
    if (!(await vault.has(envKey as string))) {
      await vault.set(envKey as string, value, {
        sensitive: true,
        caller: "wallet-os-store-migrate",
      });
      migrated.push(String(envKey));
    }
    values.push([envKey, value]);
  }

  return { migrated, values };
}

/**
 * Fills `process.env` wallet keys from the shared vault (now the source
 * of truth). On first boot after the storage unification, copies any
 * legacy OS-keystore values into the vault and then proceeds normally.
 *
 * Steward env vars stay on the OS-keystore path — the steward backend's
 * lifecycle is independent of the unified wallet vault.
 *
 * Persisted config only fills gaps that neither vault nor OS keystore
 * supplies — by call ordering on pre-merge callers, and via the captured
 * pre-merge baseline (see module header) on the deferred agent boot path.
 */
export async function hydrateWalletKeysFromNodePlatformSecureStore(
  options: {
    readEnabled?: boolean;
    secureStore?: PlatformSecureStore;
    vault?: WalletHydrationVault;
  } = {},
): Promise<void> {
  await withCredentialStateMutation(() =>
    hydrateWalletKeysFromNodePlatformSecureStoreUnlocked(options),
  );
}

async function hydrateWalletKeysFromNodePlatformSecureStoreUnlocked(options: {
  readEnabled?: boolean;
  secureStore?: PlatformSecureStore;
  vault?: WalletHydrationVault;
}): Promise<void> {
  // ── 1. Vault read for wallet keys ────────────────────────────────
  const vault = options.vault ?? sharedVault();
  const readEnabled = options.readEnabled ?? isWalletOsStoreReadEnabled();
  const store = options.secureStore ?? createNodePlatformSecureStore();
  const missingWalletKeys: Array<keyof NodeJS.ProcessEnv> = [];
  const walletValues: Array<readonly [keyof NodeJS.ProcessEnv, string]> = [];
  for (const envKey of walletVaultKeys()) {
    if (hasLaunchEnvValue(envKey)) continue;
    if (await vault.has(envKey as string)) {
      const value = await vault.reveal(envKey as string, "wallet-hydrate-boot");
      walletValues.push([envKey, value]);
      continue;
    }
    missingWalletKeys.push(envKey);
  }

  // ── 2. One-shot migration from OS keystore for any wallet keys
  //      that the vault did not have. ──────────────────────────────
  if (missingWalletKeys.length > 0) {
    const migration = await migrateOsStoreWalletKeysIntoVault(
      missingWalletKeys,
      { readEnabled, store, vault },
    );
    walletValues.push(...migration.values);
    if (migration.migrated.length > 0) {
      logger.info(
        `[wallet][vault] migrated ${migration.migrated.length} key(s) from OS keystore: ${migration.migrated.join(", ")}`,
      );
    }
  }
  for (const [envKey, value] of walletValues) process.env[envKey] = value;

  // ── 3. Steward OS-keystore reads (unchanged) ─────────────────────
  if (!readEnabled) return;
  const launchStewardEnv: NodeJS.ProcessEnv = {};
  for (const envKey of stewardLaunchEnvKeys()) {
    if (hasLaunchEnvValue(envKey))
      launchStewardEnv[envKey] = process.env[envKey];
  }
  if (hasCompleteStewardEnvironment(launchStewardEnv)) return;
  if (!(await store.isAvailable())) {
    throw new ElizaError(
      "steward secure store is unavailable during hydration",
      {
        code: "SECURE_STORE_READ_UNAVAILABLE",
        context: { operation: "steward-os-store-hydrate" },
        severity: "fatal",
      },
    );
  }
  const vaultId = deriveAgentVaultId();
  const stewardValues: Array<readonly [keyof NodeJS.ProcessEnv, string]> = [];
  for (const [envKey, kind] of stewardOsPairs()) {
    if (hasLaunchEnvValue(envKey)) continue;
    const value = secureStoreValueOrMissing(await store.get(vaultId, kind), {
      kind,
      operation: "steward-os-store-hydrate",
    });
    if (value !== null) stewardValues.push([envKey, value]);
  }
  for (const [envKey, value] of stewardValues) process.env[envKey] = value;
}
