/**
 * Steward credential persistence for non-sidecar (web/dev) mode.
 *
 * On first setup, saves non-secret steward metadata to
 * `<state-dir>/steward-credentials.json` and saves secret values to the
 * platform secure store. State dir honors ELIZA_STATE_DIR > XDG state home.
 * Environment variables always override persisted values.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared";
import { deriveAgentVaultId } from "../security/agent-vault-id";
import { withCredentialStateMutation } from "../security/credential-state-lock";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "../security/platform-secure-store";
import { createNodePlatformSecureStore } from "../security/platform-secure-store-node";
import { secureStoreValueOrMissing } from "../security/secure-store-read";

// Inlined copy of @elizaos/core's state-dir helper so this module doesn't pull
// the heavier core runtime-composition graph. Env reads go through the
// alias-aware `readAliasedEnv` so branded prefixes (e.g. `ACME_STATE_DIR`)
// resolve from the alias table, with no `process.env` mirror involved.
function resolveStateDir(): string {
  const explicit = readAliasedEnv("ELIZA_STATE_DIR");
  if (explicit) return explicit;
  const namespace = readAliasedEnv("ELIZA_NAMESPACE") || "eliza";
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  const stateHome = xdgStateHome
    ? path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(homedir(), xdgStateHome)
    : path.join(homedir(), ".local", "state");
  return path.join(stateHome, namespace);
}

export interface PersistedStewardCredentials {
  apiUrl: string;
  tenantId: string;
  agentId: string;
  apiKey: string;
  agentToken: string;
  walletAddresses?: {
    evm?: string;
    solana?: string;
  };
  agentName?: string;
  createdAt?: string;
}

const CREDENTIALS_FILENAME = "steward-credentials.json";
const STEWARD_SECRET_KINDS = {
  apiUrl: "steward.api_url",
  tenantId: "steward.tenant_id",
  agentId: "steward.agent_id",
  apiKey: "steward.api_key",
  agentToken: "steward.agent_token",
} as const satisfies Record<string, SecureStoreSecretKind>;

type StewardCredentialSecretField = keyof typeof STEWARD_SECRET_KINDS;
type StewardCredentialsMetadata = Omit<
  PersistedStewardCredentials,
  StewardCredentialSecretField
> &
  Partial<Pick<PersistedStewardCredentials, "apiUrl" | "tenantId" | "agentId">>;

interface StewardCredentialPersistenceOptions {
  secureStore?: PlatformSecureStore;
}

/** A launch environment can stand alone with bearer auth or agent-scoped API-key auth. */
export function hasCompleteStewardEnvironment(env: NodeJS.ProcessEnv): boolean {
  const apiUrl = env.STEWARD_API_URL?.trim();
  const agentId =
    env.STEWARD_AGENT_ID?.trim() || env.ELIZA_STEWARD_AGENT_ID?.trim();
  const agentToken = env.STEWARD_AGENT_TOKEN?.trim();
  const apiKey = env.STEWARD_API_KEY?.trim();
  return Boolean(apiUrl && (agentToken || (agentId && apiKey)));
}

function resolveCredentialsPath(): string {
  return path.join(resolveStateDir(), CREDENTIALS_FILENAME);
}

/** Removes persistent Steward metadata after secure-store secrets are gone. */
export function deletePersistedStewardCredentialsMetadata(): void {
  const credPath = resolveCredentialsPath();
  try {
    fs.unlinkSync(credPath);
  } catch (error) {
    // error-policy:J4 A missing metadata file already satisfies reset cleanup.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ElizaError("steward credential metadata could not be removed", {
      code: "STEWARD_CREDENTIALS_DELETE_FAILED",
      cause: error,
      context: { path: credPath },
      severity: "fatal",
    });
  }
}

function createStewardSecureStore(
  options: StewardCredentialPersistenceOptions = {},
): PlatformSecureStore {
  return options.secureStore ?? createNodePlatformSecureStore();
}

function validateCredentialsMetadata(
  value: unknown,
): Partial<PersistedStewardCredentials> & StewardCredentialsMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("credential metadata must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    "apiUrl",
    "tenantId",
    "agentId",
    "apiKey",
    "agentToken",
    "agentName",
    "createdAt",
  ]) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new TypeError(`${field} must be a string`);
    }
  }
  const walletAddresses = record.walletAddresses;
  if (walletAddresses !== undefined) {
    if (
      !walletAddresses ||
      typeof walletAddresses !== "object" ||
      Array.isArray(walletAddresses)
    ) {
      throw new TypeError("walletAddresses must be an object");
    }
    const addresses = walletAddresses as Record<string, unknown>;
    for (const field of ["evm", "solana"]) {
      const address = addresses[field];
      if (address !== undefined && typeof address !== "string") {
        throw new TypeError(`walletAddresses.${field} must be a string`);
      }
    }
  }
  return record as Partial<PersistedStewardCredentials> &
    StewardCredentialsMetadata;
}

function readCredentialsFile():
  | (Partial<PersistedStewardCredentials> & StewardCredentialsMetadata)
  | null {
  const credPath = resolveCredentialsPath();
  let serialized: string;
  try {
    serialized = fs.readFileSync(credPath, "utf-8");
  } catch (error) {
    // error-policy:J4 A missing optional credential file means Steward is not persisted.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ElizaError("steward credential metadata could not be read", {
      code: "STEWARD_CREDENTIALS_READ_FAILED",
      cause: error,
      context: { path: credPath },
      severity: "fatal",
    });
  }
  try {
    return validateCredentialsMetadata(JSON.parse(serialized) as unknown);
  } catch (error) {
    // error-policy:J3 Corrupt persisted JSON is an explicit invalid state, never absence.
    throw new ElizaError("steward credential metadata is invalid", {
      code: "STEWARD_CREDENTIALS_INVALID",
      cause: error,
      context: { path: credPath },
      severity: "fatal",
    });
  }
}

function writeCredentialsMetadata(
  credentials: PersistedStewardCredentials | StewardCredentialsMetadata,
): void {
  const credPath = resolveCredentialsPath();
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data: StewardCredentialsMetadata = {
    walletAddresses: credentials.walletAddresses,
    agentName: credentials.agentName,
    createdAt: credentials.createdAt ?? new Date().toISOString(),
  };
  if (credentials.apiUrl) data.apiUrl = credentials.apiUrl;
  if (credentials.tenantId) data.tenantId = credentials.tenantId;
  if (credentials.agentId) data.agentId = credentials.agentId;

  const temporaryPath = path.join(
    dir,
    `.${CREDENTIALS_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, JSON.stringify(data, null, 2), "utf8");
    if (process.platform !== "win32") fs.fchmodSync(fileDescriptor, 0o600);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryPath, credPath);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch (closeError) {
        // error-policy:J6 The primary atomic-write failure remains observable below.
        logger.warn(
          `[StewardCredentials] Failed to close metadata temp file: ${String(closeError)}`,
        );
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      // error-policy:J6 The primary atomic-write failure remains observable below.
      logger.warn(
        `[StewardCredentials] Failed to remove metadata temp file: ${String(cleanupError)}`,
      );
    }
    throw new ElizaError("steward credential metadata could not be written", {
      code: "STEWARD_CREDENTIALS_WRITE_FAILED",
      cause: error,
      context: { path: credPath },
      severity: "fatal",
    });
  }
}

async function readStewardSecret(
  store: PlatformSecureStore,
  vaultId: string,
  field: StewardCredentialSecretField,
): Promise<string | null> {
  const kind = STEWARD_SECRET_KINDS[field];
  const value = secureStoreValueOrMissing(await store.get(vaultId, kind), {
    kind,
    operation: "steward-credentials-load",
  });
  return value?.trim() || null;
}

async function writeStewardSecret(
  store: PlatformSecureStore,
  vaultId: string,
  field: StewardCredentialSecretField,
  value: string,
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return;
  const result = await store.set(vaultId, STEWARD_SECRET_KINDS[field], trimmed);
  if (!result.ok) {
    throw new ElizaError("secure store rejected steward credential write", {
      code: "SECURE_STORE_WRITE_FAILED",
      context: { field, reason: result.reason },
      severity: "fatal",
    });
  }
}

async function migrateLegacyFileSecrets(
  store: PlatformSecureStore,
  vaultId: string,
  parsed: Partial<PersistedStewardCredentials> & StewardCredentialsMetadata,
): Promise<void> {
  const migrated: Partial<PersistedStewardCredentials> = {};
  for (const field of Object.keys(
    STEWARD_SECRET_KINDS,
  ) as StewardCredentialSecretField[]) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      await writeStewardSecret(store, vaultId, field, value);
      migrated[field] = value.trim();
    }
  }
  if (Object.keys(migrated).length > 0) {
    for (const [field, expected] of Object.entries(migrated) as Array<
      [StewardCredentialSecretField, string]
    >) {
      const stored = await readStewardSecret(store, vaultId, field);
      if (stored !== expected) {
        throw new ElizaError(
          "secure-store steward migration verification failed",
          {
            code: "SECURE_STORE_MIGRATION_VERIFICATION_FAILED",
            context: { field },
            severity: "fatal",
          },
        );
      }
    }
    writeCredentialsMetadata({ ...parsed, ...migrated });
  }
}

/**
 * Load persisted steward credentials from metadata + platform secure store.
 * Returns null when no file exists or required identity fields are incomplete.
 * Invalid or unreadable persistence and secure-store failures remain typed.
 */
export async function loadStewardCredentials(
  options: StewardCredentialPersistenceOptions = {},
): Promise<PersistedStewardCredentials | null> {
  return withCredentialStateMutation(() =>
    loadStewardCredentialsUnlocked(options),
  );
}

async function loadStewardCredentialsUnlocked(
  options: StewardCredentialPersistenceOptions,
): Promise<PersistedStewardCredentials | null> {
  const parsed = readCredentialsFile();
  if (!parsed) return null;

  const store = createStewardSecureStore(options);
  const hasLegacySecrets = (
    Object.keys(STEWARD_SECRET_KINDS) as StewardCredentialSecretField[]
  ).some((field) => {
    const value = parsed[field];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!(await store.isAvailable())) {
    throw new ElizaError(
      "secure store is unavailable for steward credentials",
      {
        code: "SECURE_STORE_READ_UNAVAILABLE",
        context: {
          operation: "steward-credentials-load",
          hasLegacySecrets,
        },
        severity: "fatal",
      },
    );
  }
  const vaultId = deriveAgentVaultId();
  await migrateLegacyFileSecrets(store, vaultId, parsed);

  const secureValues: Partial<
    Pick<PersistedStewardCredentials, StewardCredentialSecretField>
  > = {};
  for (const field of Object.keys(
    STEWARD_SECRET_KINDS,
  ) as StewardCredentialSecretField[]) {
    const value = await readStewardSecret(store, vaultId, field);
    if (value) {
      secureValues[field] = value;
    }
  }

  const apiUrl = secureValues.apiUrl || parsed.apiUrl || null;
  const tenantId = secureValues.tenantId || parsed.tenantId || null;
  const agentId = secureValues.agentId || parsed.agentId || null;
  if (!apiUrl || !tenantId || !agentId) {
    return null;
  }

  return {
    apiUrl,
    tenantId,
    agentId,
    apiKey: secureValues.apiKey || "",
    agentToken: secureValues.agentToken || "",
    walletAddresses: parsed.walletAddresses,
    agentName: parsed.agentName,
    createdAt: parsed.createdAt,
  };
}

/**
 * Save steward credentials to the platform secure store and metadata to disk.
 */
export async function saveStewardCredentials(
  credentials: PersistedStewardCredentials,
  options: StewardCredentialPersistenceOptions = {},
): Promise<void> {
  await withCredentialStateMutation(() =>
    saveStewardCredentialsUnlocked(credentials, options),
  );
}

async function saveStewardCredentialsUnlocked(
  credentials: PersistedStewardCredentials,
  options: StewardCredentialPersistenceOptions,
): Promise<void> {
  const store = createStewardSecureStore(options);
  if (!(await store.isAvailable())) {
    throw new ElizaError(
      "secure store is unavailable for steward credentials",
      {
        code: "SECURE_STORE_WRITE_UNAVAILABLE",
        context: { operation: "steward-credentials-save" },
        severity: "fatal",
      },
    );
  }
  const vaultId = deriveAgentVaultId();
  await Promise.all(
    (Object.keys(STEWARD_SECRET_KINDS) as StewardCredentialSecretField[]).map(
      (field) => writeStewardSecret(store, vaultId, field, credentials[field]),
    ),
  );

  writeCredentialsMetadata(credentials);
}

/**
 * Resolve effective steward configuration by merging:
 *   env vars > persisted file > defaults
 *
 * Returns null if steward is not configured at all.
 */
export async function resolveEffectiveStewardConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: StewardCredentialPersistenceOptions = {},
): Promise<PersistedStewardCredentials | null> {
  const completeEnvironment = {
    apiUrl: env.STEWARD_API_URL?.trim(),
    tenantId: env.STEWARD_TENANT_ID?.trim(),
    agentId: env.STEWARD_AGENT_ID?.trim() || env.ELIZA_STEWARD_AGENT_ID?.trim(),
    apiKey: env.STEWARD_API_KEY?.trim(),
    agentToken: env.STEWARD_AGENT_TOKEN?.trim(),
  };
  if (completeEnvironment.apiUrl && hasCompleteStewardEnvironment(env)) {
    return {
      apiUrl: completeEnvironment.apiUrl,
      tenantId: completeEnvironment.tenantId || "",
      agentId: completeEnvironment.agentId || "",
      apiKey: completeEnvironment.apiKey || "",
      agentToken: completeEnvironment.agentToken || "",
    };
  }
  const persisted = await loadStewardCredentials(options);

  const apiUrl = env.STEWARD_API_URL?.trim() || persisted?.apiUrl || null;
  if (!apiUrl) {
    return null;
  }

  const tenantId = env.STEWARD_TENANT_ID?.trim() || persisted?.tenantId || null;
  const agentId =
    env.STEWARD_AGENT_ID?.trim() ||
    env.ELIZA_STEWARD_AGENT_ID?.trim() ||
    persisted?.agentId ||
    null;
  const apiKey = env.STEWARD_API_KEY?.trim() || persisted?.apiKey || "";
  const agentToken =
    env.STEWARD_AGENT_TOKEN?.trim() || persisted?.agentToken || "";

  return {
    apiUrl,
    tenantId: tenantId || "",
    agentId: agentId || "",
    apiKey,
    agentToken,
    walletAddresses: persisted?.walletAddresses,
    agentName: persisted?.agentName,
    createdAt: persisted?.createdAt,
  };
}
