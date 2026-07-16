/**
 * Node-side OS secure-store backends for agent secrets: macOS Keychain (the
 * `security` CLI, passwords passed via stdin to keep them out of argv / `ps`),
 * Linux libsecret (`secret-tool`), and an explicit unavailable backend on
 * platforms with no adapter. Exposes the platform factory plus availability and
 * env-gated (`ELIZA_WALLET_OS_STORE`) enablement checks for the wallet key path.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ElizaError, logger } from "@elizaos/core";
import {
  deriveCompatibleVaultTokens,
  ELIZA_AGENT_VAULT_SERVICE,
  keychainAccountForSecretKind,
} from "./agent-vault-id";
import type {
  PlatformSecureStore,
  PlatformSecureStoreBackend,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "./platform-secure-store";
import {
  collectSecureStoreCleanupTargets,
  enumerateSecretServiceMetadata,
  MacOSKeychainMetadataParser,
  preferCurrentSecretAfterRecovery,
  promoteRecoveredMacOSSecret,
  readCurrentOrRecover,
  recoverCompatibleSecret,
  type SecretServiceMetadataBus,
  type SecureStoreMetadataRef,
} from "./secure-store-compatibility";

const execFileAsync = promisify(execFile);
const MACOS_SECURITY_COMMAND = "/usr/bin/security";
const SECRET_SERVICE_METADATA_TIMEOUT_MS = 5_000;

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

/**
 * Write a password to the macOS Keychain via stdin to avoid argv exposure.
 * The `security add-generic-password` command reads from stdin when `-w`
 * is the last argument with no value. It prompts twice (password + retype),
 * so we write the value twice separated by a newline.
 */
function keychainSetViaStdin(args: string[], password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(MACOS_SECURITY_COMMAND, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        Object.assign(new Error(stderr.trim() || `security exited ${code}`), {
          stderr,
          code,
        }),
      );
    });
    // error-policy:J5 The child close handler reports the command failure.
    child.stdin.on("error", () => {});
    // Write password twice (password + retype) then close stdin
    child.stdin.write(`${password}\n${password}\n`, () => {
      child.stdin.end();
    });
  });
}

function secretToolStoreWithStdin(
  args: string[],
  secretLine: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        Object.assign(
          new Error(stderr.trim() || `secret-tool exited ${code}`),
          {
            stderr,
            code,
          },
        ),
      );
    });
    const line = secretLine.endsWith("\n") ? secretLine : `${secretLine}\n`;
    child.stdin.write(line, "utf8");
    child.stdin.end();
  });
}

/**
 * Check if `secret-tool` is available on PATH without spawning a shell.
 * Iterates PATH entries directly and checks for the executable.
 */
function secretToolOnPathSync(): boolean {
  if (process.platform === "win32") return false;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "secret-tool");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // error-policy:J4 PATH probing expects most entries not to contain the tool.
    }
  }
  return false;
}

async function secretToolOnPath(): Promise<boolean> {
  return secretToolOnPathSync();
}

function secureStoreOperationError(code: string, message: string): ElizaError {
  return new ElizaError(message, { code, severity: "fatal" });
}

function discoverMacOSKeychainMetadata(): Promise<SecureStoreMetadataRef[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(MACOS_SECURITY_COMMAND, ["dump-keychain"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parser = new MacOSKeychainMetadataParser();
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => parser.push(chunk));
    child.stderr.resume();
    child.on("error", () => {
      if (settled) return;
      settled = true;
      reject(
        secureStoreOperationError(
          "SECURE_STORE_METADATA_DISCOVERY_FAILED",
          "macOS secure-store metadata discovery failed",
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          secureStoreOperationError(
            "SECURE_STORE_METADATA_DISCOVERY_FAILED",
            "macOS secure-store metadata discovery failed",
          ),
        );
        return;
      }
      resolve(parser.finish());
    });
  });
}

async function readMacOSKeychainSecret(
  service: string,
  account: string,
  keychain?: string,
): Promise<SecureStoreGetResult> {
  const args = ["find-generic-password", "-s", service, "-a", account, "-w"];
  if (keychain) args.push(keychain);
  try {
    const { stdout } = await execFileAsync(MACOS_SECURITY_COMMAND, args, {
      encoding: "utf8",
    });
    const value = stdout.trim();
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  } catch (err: unknown) {
    // error-policy:J1 The command boundary translates native status to the store contract.
    const error = err as { stderr?: string; code?: number };
    return macErrReason(String(error.stderr ?? ""), error.code ?? null);
  }
}

async function deleteMacOSKeychainSecret(
  service: string,
  account: string,
  keychain?: string,
): Promise<void> {
  const args = ["delete-generic-password", "-s", service, "-a", account];
  if (keychain) args.push(keychain);
  try {
    await execFileAsync(MACOS_SECURITY_COMMAND, args);
  } catch (err: unknown) {
    // error-policy:J1 Missing entries are idempotent; other native failures abort reset.
    const error = err as { stderr?: string; code?: number };
    const result = macErrReason(String(error.stderr ?? ""), error.code ?? null);
    if (!result.ok && result.reason === "not_found") return;
    throw secureStoreOperationError(
      "SECURE_STORE_DELETE_FAILED",
      "macOS secure-store deletion failed",
    );
  }
}

interface RuntimeSecretServiceConnection {
  on: (event: "error", listener: (error: unknown) => void) => unknown;
  off?: (event: "error", listener: (error: unknown) => void) => unknown;
  removeListener?: (
    event: "error",
    listener: (error: unknown) => void,
  ) => unknown;
  end?: () => unknown;
  stream?: { end: () => unknown };
}

export interface RuntimeSecretServiceBus extends SecretServiceMetadataBus {
  connection?: RuntimeSecretServiceConnection;
}

type SecretServiceBusFactory = () => RuntimeSecretServiceBus;

function requireSecretServiceConnection(
  bus: RuntimeSecretServiceBus,
): RuntimeSecretServiceConnection {
  const connection = bus.connection;
  if (
    !connection ||
    typeof connection.on !== "function" ||
    (typeof connection.off !== "function" &&
      typeof connection.removeListener !== "function")
  ) {
    throw secureStoreOperationError(
      "SECURE_STORE_METADATA_CLIENT_INVALID",
      "Secret Service metadata connection is unavailable",
    );
  }
  return connection;
}

function removeSecretServiceConnectionErrorListener(
  connection: RuntimeSecretServiceConnection,
  listener: (error: unknown) => void,
): void {
  if (connection.off) {
    connection.off("error", listener);
    return;
  }
  connection.removeListener?.("error", listener);
}

function disconnectSecretServiceBus(bus: RuntimeSecretServiceBus): void {
  if (bus.connection?.end) {
    bus.connection.end();
    return;
  }
  bus.connection?.stream?.end();
}

/**
 * Runs metadata discovery while owning the D-Bus connection error lifecycle.
 * The client forwards socket failures through an EventEmitter, so the listener
 * must exist before the first invocation or an unreachable session bus can
 * terminate the process instead of producing a secure-store failure.
 */
export async function enumerateLinuxSecretServiceMetadataForBus(
  bus: RuntimeSecretServiceBus,
  timeoutMs = SECRET_SERVICE_METADATA_TIMEOUT_MS,
): Promise<SecureStoreMetadataRef[]> {
  const connection = requireSecretServiceConnection(bus);
  let rejectConnectionError: ((error: ElizaError) => void) | undefined;
  const connectionError = new Promise<never>((_resolve, reject) => {
    rejectConnectionError = reject;
  });
  const onConnectionError = (): void => {
    rejectConnectionError?.(
      secureStoreOperationError(
        "SECURE_STORE_METADATA_CONNECTION_FAILED",
        "Secret Service metadata connection failed",
      ),
    );
  };
  connection.on("error", onConnectionError);

  try {
    return await Promise.race([
      enumerateSecretServiceMetadata(bus, timeoutMs),
      connectionError,
    ]);
  } finally {
    try {
      disconnectSecretServiceBus(bus);
    } catch {
      // error-policy:J6 Metadata enumeration already has an observable result.
      logger.warn(
        "[PlatformSecureStore] Secret Service metadata disconnect failed",
      );
    } finally {
      removeSecretServiceConnectionErrorListener(connection, onConnectionError);
    }
  }
}

async function loadSecretServiceBusFactory(): Promise<SecretServiceBusFactory> {
  const imported: unknown = await import("@homebridge/dbus-native");
  const namespace = imported as {
    sessionBus?: SecretServiceBusFactory;
    default?: { sessionBus?: SecretServiceBusFactory };
  };
  const factory = namespace.sessionBus ?? namespace.default?.sessionBus;
  if (!factory) {
    throw secureStoreOperationError(
      "SECURE_STORE_METADATA_CLIENT_INVALID",
      "Secret Service metadata client is unavailable",
    );
  }
  return factory;
}

async function discoverLinuxSecretServiceMetadata(): Promise<
  SecureStoreMetadataRef[]
> {
  const factory = await loadSecretServiceBusFactory();
  const bus = factory();
  return enumerateLinuxSecretServiceMetadataForBus(bus);
}

async function readLinuxSecret(
  service: string,
  account: string,
): Promise<SecureStoreGetResult> {
  try {
    const { stdout } = await execFileAsync(
      "secret-tool",
      ["lookup", "service", service, "account", account],
      { encoding: "utf8" },
    );
    const value = stdout.trim();
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  } catch (err: unknown) {
    // error-policy:J1 The command boundary translates libsecret status to the store contract.
    const error = err as { stderr?: string; code?: number };
    const stderr = String(error.stderr ?? "");
    if (error.code === 1 || stderr.toLowerCase().includes("not found")) {
      return { ok: false, reason: "not_found" };
    }
    return {
      ok: false,
      reason: "error",
      message: "Secret Service targeted read failed",
    };
  }
}

async function clearLinuxSecret(
  service: string,
  account: string,
): Promise<void> {
  try {
    await execFileAsync("secret-tool", [
      "clear",
      "service",
      service,
      "account",
      account,
    ]);
  } catch {
    // error-policy:J1 Reset cannot succeed while a recoverable entry remains.
    throw secureStoreOperationError(
      "SECURE_STORE_DELETE_FAILED",
      "Secret Service deletion failed",
    );
  }
}

function assertCleanupComplete(
  refs: readonly SecureStoreMetadataRef[],
  currentService: string,
  currentAccount: string,
  kind: SecureStoreSecretKind,
  compatibleTokens: ReadonlySet<string>,
): void {
  if (
    collectSecureStoreCleanupTargets(
      refs,
      currentService,
      currentAccount,
      kind,
      compatibleTokens,
    ).length > 0
  ) {
    throw secureStoreOperationError(
      "SECURE_STORE_DELETE_INCOMPLETE",
      "secure-store cleanup verification found a recoverable entry",
    );
  }
}

function macErrReason(
  stderr: string,
  code: number | null,
): SecureStoreGetResult {
  const s = stderr.toLowerCase();
  if (
    s.includes("could not be found") ||
    s.includes("the specified item could not be found")
  ) {
    return { ok: false, reason: "not_found" };
  }
  if (s.includes("user canceled") || s.includes("user cancelled")) {
    return { ok: false, reason: "denied" };
  }
  return {
    ok: false,
    reason: code === 44 || code === 45 ? "denied" : "error",
    message: "macOS secure-store command failed",
  };
}

class MacOSKeychainPlatformSecureStore implements PlatformSecureStore {
  readonly backend: PlatformSecureStoreBackend = "macos_keychain";

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(MACOS_SECURITY_COMMAND, ["-h"], {
        encoding: "utf8",
      });
      return true;
    } catch {
      // error-policy:J4 keychain tool unavailable (probe)
      return false;
    }
  }

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    return readCurrentOrRecover({
      readCurrent: () =>
        readMacOSKeychainSecret(ELIZA_AGENT_VAULT_SERVICE, account),
      recover: async () => {
        try {
          const recovered = await recoverCompatibleSecret({
            discover: discoverMacOSKeychainMetadata,
            read: (candidate) =>
              readMacOSKeychainSecret(
                candidate.service,
                candidate.account,
                candidate.locator,
              ),
            currentService: ELIZA_AGENT_VAULT_SERVICE,
            currentAccount: account,
            kind,
            compatibleTokens: deriveCompatibleVaultTokens(vaultId),
          });
          if (!recovered.ok) return recovered;
          return promoteRecoveredMacOSSecret({
            recoveredValue: recovered.value,
            addOnly: (value) =>
              keychainSetViaStdin(
                [
                  "add-generic-password",
                  "-s",
                  ELIZA_AGENT_VAULT_SERVICE,
                  "-a",
                  account,
                  "-w",
                ],
                value,
              ),
            readCurrent: () =>
              readMacOSKeychainSecret(ELIZA_AGENT_VAULT_SERVICE, account),
          });
        } catch {
          // error-policy:J1 Compatibility discovery failures become an observable read error.
          return {
            ok: false,
            reason: "error",
            message: "macOS secure-store compatibility recovery failed",
          };
        }
      },
    });
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    try {
      // Pass password via stdin instead of argv to avoid exposure via `ps`.
      // The `-w` flag (last, with no value) triggers stdin read mode.
      await keychainSetViaStdin(
        [
          "add-generic-password",
          "-s",
          ELIZA_AGENT_VAULT_SERVICE,
          "-a",
          account,
          "-U",
          "-w",
        ],
        value,
      );
      return { ok: true };
    } catch {
      // error-policy:J1 The command boundary returns a structured write failure.
      return {
        ok: false,
        reason: "error",
        message: "macOS secure-store write failed",
      };
    }
  }

  async delete(vaultId: string, kind: SecureStoreSecretKind): Promise<void> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    const compatibleTokens = deriveCompatibleVaultTokens(vaultId);
    const refs = await discoverMacOSKeychainMetadata();
    const targets = collectSecureStoreCleanupTargets(
      refs,
      ELIZA_AGENT_VAULT_SERVICE,
      account,
      kind,
      compatibleTokens,
    );
    for (const target of targets) {
      await deleteMacOSKeychainSecret(
        target.service,
        target.account,
        target.locator,
      );
    }
    assertCleanupComplete(
      await discoverMacOSKeychainMetadata(),
      ELIZA_AGENT_VAULT_SERVICE,
      account,
      kind,
      compatibleTokens,
    );
  }
}

/** Linux: `secret-tool` from libsecret (GNOME Keyring / KWallet Secret Service). */
class LinuxSecretToolPlatformSecureStore implements PlatformSecureStore {
  readonly backend: PlatformSecureStoreBackend = "linux_secret_service";

  async isAvailable(): Promise<boolean> {
    return secretToolOnPath();
  }

  private account(vaultId: string, kind: SecureStoreSecretKind): string {
    return keychainAccountForSecretKind(vaultId, kind);
  }

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const account = this.account(vaultId, kind);
    return readCurrentOrRecover({
      readCurrent: () => readLinuxSecret(ELIZA_AGENT_VAULT_SERVICE, account),
      recover: async () => {
        try {
          const recovered = await recoverCompatibleSecret({
            discover: discoverLinuxSecretServiceMetadata,
            read: (candidate) =>
              readLinuxSecret(candidate.service, candidate.account),
            currentService: ELIZA_AGENT_VAULT_SERVICE,
            currentAccount: account,
            kind,
            compatibleTokens: deriveCompatibleVaultTokens(vaultId),
          });
          return preferCurrentSecretAfterRecovery({
            recovered,
            readCurrent: () =>
              readLinuxSecret(ELIZA_AGENT_VAULT_SERVICE, account),
          });
        } catch {
          // error-policy:J1 Compatibility discovery failures become an observable read error.
          return {
            ok: false,
            reason: "error",
            message: "Secret Service compatibility recovery failed",
          };
        }
      },
    });
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    const account = this.account(vaultId, kind);
    try {
      await secretToolStoreWithStdin(
        [
          "store",
          "--label=Eliza agent wallet",
          "service",
          ELIZA_AGENT_VAULT_SERVICE,
          "account",
          account,
        ],
        value,
      );
      return { ok: true };
    } catch {
      // error-policy:J1 The command boundary returns a structured write failure.
      return {
        ok: false,
        reason: "error",
        message: "Secret Service write failed",
      };
    }
  }

  async delete(vaultId: string, kind: SecureStoreSecretKind): Promise<void> {
    const account = this.account(vaultId, kind);
    const compatibleTokens = deriveCompatibleVaultTokens(vaultId);
    const refs = await discoverLinuxSecretServiceMetadata();
    const targets = collectSecureStoreCleanupTargets(
      refs,
      ELIZA_AGENT_VAULT_SERVICE,
      account,
      kind,
      compatibleTokens,
    );
    for (const target of targets) {
      await clearLinuxSecret(target.service, target.account);
    }
    assertCleanupComplete(
      await discoverLinuxSecretServiceMetadata(),
      ELIZA_AGENT_VAULT_SERVICE,
      account,
      kind,
      compatibleTokens,
    );
  }
}

class NonePlatformSecureStore implements PlatformSecureStore {
  constructor(readonly backend: PlatformSecureStoreBackend = "none") {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async get(): Promise<SecureStoreGetResult> {
    return { ok: false, reason: "unavailable" };
  }

  async set(): Promise<SecureStoreSetResult> {
    return { ok: false, reason: "unavailable" };
  }

  async delete(): Promise<void> {}
}

/**
 * Node-side factory: macOS Keychain, Linux `secret-tool`, or the explicit
 * unavailable backend on platforms without an OS credential-store adapter.
 */
export function createNodePlatformSecureStore(): PlatformSecureStore {
  if (isDarwin()) {
    return new MacOSKeychainPlatformSecureStore();
  }
  if (isLinux()) {
    return new LinuxSecretToolPlatformSecureStore();
  }
  return new NonePlatformSecureStore();
}

export function isNodePlatformSecureStoreSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin" || platform === "linux";
}

const WALLET_OS_STORE_TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const WALLET_OS_STORE_FALSE_VALUES = new Set(["0", "false", "off", "no"]);

export function isNodePlatformSecureStoreDefaultAvailable(): boolean {
  if (isDarwin()) return true;
  if (isLinux()) return secretToolOnPathSync();
  return false;
}

/**
 * Explicit override: `ELIZA_WALLET_OS_STORE=0|false|off|no` disables this path.
 * When unset, default on for supported local secure stores.
 */
export function isWalletOsStoreReadEnabled(): boolean {
  const raw = process.env.ELIZA_WALLET_OS_STORE?.trim().toLowerCase();
  if (raw) {
    if (WALLET_OS_STORE_TRUE_VALUES.has(raw)) return true;
    if (WALLET_OS_STORE_FALSE_VALUES.has(raw)) return false;
  }
  return isNodePlatformSecureStoreDefaultAvailable();
}
