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
import { isMobilePlatform } from "@elizaos/shared";
import {
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
  type CompatibleSecretRecoveryResult,
  cleanupCurrentAndCompatibleSecret,
  enumerateSecretServiceMetadata,
  MacOSKeychainMetadataParser,
  preferCurrentSecretAfterRecovery,
  promoteRecoveredMacOSSecret,
  readCurrentOrRecover,
  recoverCompatibleSecret,
  type SecretServiceMetadataBus,
  type SecureStoreMetadataRef,
  SecureStoreMetadataSnapshotCache,
} from "./secure-store-compatibility";

const execFileAsync = promisify(execFile);
const MACOS_SECURITY_COMMAND = "/usr/bin/security";
const SECRET_SERVICE_METADATA_TIMEOUT_MS = 5_000;
const NATIVE_COMMAND_TIMEOUT_MS = 5_000;
const NATIVE_COMMAND_MAX_OUTPUT_BYTES = 64 * 1_024;
const MACOS_METADATA_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;

function isDarwin(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

function isLinux(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}

function nativeExecOptions(): {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  killSignal: NodeJS.Signals;
} {
  return {
    encoding: "utf8",
    timeout: NATIVE_COMMAND_TIMEOUT_MS,
    maxBuffer: NATIVE_COMMAND_MAX_OUTPUT_BYTES,
    killSignal: "SIGKILL",
  };
}

function terminateNativeChild(child: ReturnType<typeof spawn>): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // error-policy:J6 The command failure remains observable to its caller.
    logger.warn("[PlatformSecureStore] Failed to terminate native command");
  }
}

function runNativeCommandWithStdin(options: {
  command: string;
  args: string[];
  input: string;
  errorCode: string;
  errorMessage: string;
}): Promise<void> {
  if (Buffer.byteLength(options.input) > NATIVE_COMMAND_MAX_OUTPUT_BYTES) {
    return Promise.reject(
      secureStoreOperationError(
        `${options.errorCode}_INPUT_LIMIT_EXCEEDED`,
        `${options.errorMessage}: input limit exceeded`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let outputBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: ElizaError): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };
    const accountOutput = (chunk: Buffer | string): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes <= NATIVE_COMMAND_MAX_OUTPUT_BYTES) return;
      terminateNativeChild(child);
      fail(
        secureStoreOperationError(
          `${options.errorCode}_OUTPUT_LIMIT_EXCEEDED`,
          `${options.errorMessage}: output limit exceeded`,
        ),
      );
    };
    child.stdout.on("data", accountOutput);
    child.stderr.on("data", accountOutput);
    child.on("error", (error) => {
      fail(
        secureStoreOperationError(
          options.errorCode,
          options.errorMessage,
          error,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        secureStoreOperationError(options.errorCode, options.errorMessage),
      );
    });
    timeout = setTimeout(() => {
      terminateNativeChild(child);
      fail(
        secureStoreOperationError(
          `${options.errorCode}_TIMEOUT`,
          `${options.errorMessage}: timed out`,
        ),
      );
    }, NATIVE_COMMAND_TIMEOUT_MS);
    // error-policy:J5 The close/error handlers report command failure.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input, "utf8");
  });
}

/**
 * Write a password to the macOS Keychain via stdin to avoid argv exposure.
 * The `security add-generic-password` command reads from stdin when `-w`
 * is the last argument with no value. It prompts twice (password + retype),
 * so we write the value twice separated by a newline.
 */
function keychainSetViaStdin(args: string[], password: string): Promise<void> {
  return runNativeCommandWithStdin({
    command: MACOS_SECURITY_COMMAND,
    args,
    input: `${password}\n${password}\n`,
    errorCode: "SECURE_STORE_MACOS_WRITE_FAILED",
    errorMessage: "macOS secure-store write failed",
  });
}

function secretToolStoreWithStdin(
  args: string[],
  secretLine: string,
): Promise<void> {
  return runNativeCommandWithStdin({
    command: "secret-tool",
    args,
    input: secretLine.endsWith("\n") ? secretLine : `${secretLine}\n`,
    errorCode: "SECURE_STORE_LINUX_WRITE_FAILED",
    errorMessage: "Secret Service write failed",
  });
}

/**
 * Check if `secret-tool` is available on PATH without spawning a shell.
 * Iterates PATH entries directly and checks for the executable.
 */
function secretToolOnPathSync(pathEnv = process.env.PATH): boolean {
  if (process.platform === "win32" || !pathEnv) return false;
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
  if (!secretToolOnPathSync()) return false;
  try {
    await execFileAsync("secret-tool", ["--help"], nativeExecOptions());
    return true;
  } catch {
    // error-policy:J4 Availability probes return false without exposing native output.
    return false;
  }
}

function secureStoreOperationError(
  code: string,
  message: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
    ...(cause === undefined ? {} : { cause }),
  });
}

function loadMacOSKeychainMetadata(): Promise<SecureStoreMetadataRef[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(MACOS_SECURITY_COMMAND, ["dump-keychain"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parser = new MacOSKeychainMetadataParser();
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: ElizaError): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MACOS_METADATA_MAX_OUTPUT_BYTES) {
        const error = secureStoreOperationError(
          "SECURE_STORE_METADATA_OUTPUT_LIMIT_EXCEEDED",
          "macOS secure-store metadata exceeded its output limit",
        );
        terminateNativeChild(child);
        fail(error);
        return;
      }
      try {
        parser.push(chunk);
      } catch (error) {
        // error-policy:J2 Preserve the bounded parser failure at the command boundary.
        const wrapped = secureStoreOperationError(
          "SECURE_STORE_METADATA_PARSE_FAILED",
          "macOS secure-store metadata parsing failed",
          error,
        );
        terminateNativeChild(child);
        fail(wrapped);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= NATIVE_COMMAND_MAX_OUTPUT_BYTES) return;
      const error = secureStoreOperationError(
        "SECURE_STORE_METADATA_OUTPUT_LIMIT_EXCEEDED",
        "macOS secure-store metadata exceeded its output limit",
      );
      terminateNativeChild(child);
      fail(error);
    });
    child.on("error", (error) => {
      fail(
        secureStoreOperationError(
          "SECURE_STORE_METADATA_DISCOVERY_FAILED",
          "macOS secure-store metadata discovery failed",
          error,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code !== 0) {
        reject(
          secureStoreOperationError(
            "SECURE_STORE_METADATA_DISCOVERY_FAILED",
            "macOS secure-store metadata discovery failed",
          ),
        );
        return;
      }
      try {
        resolve(parser.finish());
      } catch (error) {
        // error-policy:J2 Preserve the bounded parser failure at the command boundary.
        reject(
          secureStoreOperationError(
            "SECURE_STORE_METADATA_PARSE_FAILED",
            "macOS secure-store metadata parsing failed",
            error,
          ),
        );
      }
    });
    timeout = setTimeout(() => {
      terminateNativeChild(child);
      fail(
        secureStoreOperationError(
          "SECURE_STORE_METADATA_DISCOVERY_TIMEOUT",
          "macOS secure-store metadata discovery timed out",
        ),
      );
    }, NATIVE_COMMAND_TIMEOUT_MS);
  });
}

const macOSMetadataCache = new SecureStoreMetadataSnapshotCache(
  loadMacOSKeychainMetadata,
);

async function discoverMacOSKeychainMetadata(
  forceRefresh = false,
): Promise<readonly SecureStoreMetadataRef[]> {
  return macOSMetadataCache.get(forceRefresh);
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
      ...nativeExecOptions(),
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
    await execFileAsync(MACOS_SECURITY_COMMAND, args, nativeExecOptions());
  } catch (err: unknown) {
    // error-policy:J1 Missing entries are idempotent; other native failures abort reset.
    const error = err as { stderr?: string; code?: number };
    const result = macErrReason(String(error.stderr ?? ""), error.code ?? null);
    if (!result.ok && result.reason === "not_found") return;
    throw secureStoreOperationError(
      "SECURE_STORE_DELETE_FAILED",
      "macOS secure-store deletion failed",
      err,
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
  stream?: {
    end: () => unknown;
    once?: (event: "close", listener: () => void) => unknown;
    destroyed?: boolean;
  };
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

function removeSecretServiceConnectionErrorListenerOnClose(
  connection: RuntimeSecretServiceConnection,
  listener: (error: unknown) => void,
): void {
  const remove = (): void => {
    if (connection.off) {
      connection.off("error", listener);
      return;
    }
    connection.removeListener?.("error", listener);
  };
  if (connection.stream?.destroyed) {
    // A failed socket can still trigger a handshake error after its first
    // network error; retain the observer until this bounded bus is collected.
    return;
  }
  if (connection.stream?.once) {
    connection.stream.once("close", remove);
  }
  // Without a close hook the bounded bus object retains this listener until it
  // is collected, which is safer than exposing a late socket error as an
  // unhandled EventEmitter exception.
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
  let operationSettled = false;
  const connectionError = new Promise<never>((_resolve, reject) => {
    rejectConnectionError = reject;
  });
  const onConnectionError = (): void => {
    if (operationSettled) {
      logger.warn(
        "[PlatformSecureStore] Secret Service connection failed during teardown",
      );
      return;
    }
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
    operationSettled = true;
    removeSecretServiceConnectionErrorListenerOnClose(
      connection,
      onConnectionError,
    );
    try {
      disconnectSecretServiceBus(bus);
    } catch {
      // error-policy:J6 Metadata enumeration already has an observable result.
      logger.warn(
        "[PlatformSecureStore] Secret Service metadata disconnect failed",
      );
    }
  }
}

async function loadSecretServiceBusFactory(): Promise<SecretServiceBusFactory> {
  let imported: unknown;
  try {
    imported = await import("@homebridge/dbus-native");
  } catch (error) {
    // error-policy:J2 Preserve module-load failure without exposing local paths.
    throw secureStoreOperationError(
      "SECURE_STORE_METADATA_CLIENT_LOAD_FAILED",
      "Secret Service metadata client failed to load",
      error,
    );
  }
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

async function loadLinuxSecretServiceMetadata(): Promise<
  SecureStoreMetadataRef[]
> {
  const factory = await loadSecretServiceBusFactory();
  let bus: RuntimeSecretServiceBus;
  try {
    bus = factory();
  } catch (error) {
    // error-policy:J2 Preserve session-bus creation failure at the native boundary.
    throw secureStoreOperationError(
      "SECURE_STORE_METADATA_SESSION_FAILED",
      "Secret Service metadata session failed to open",
      error,
    );
  }
  return enumerateLinuxSecretServiceMetadataForBus(bus);
}

const linuxMetadataCache = new SecureStoreMetadataSnapshotCache(
  loadLinuxSecretServiceMetadata,
);

async function discoverLinuxSecretServiceMetadata(
  forceRefresh = false,
): Promise<readonly SecureStoreMetadataRef[]> {
  return linuxMetadataCache.get(forceRefresh);
}

async function readLinuxSecret(
  service: string,
  account: string,
): Promise<SecureStoreGetResult> {
  try {
    const { stdout } = await execFileAsync(
      "secret-tool",
      ["lookup", "service", service, "account", account],
      nativeExecOptions(),
    );
    const value = stdout.trim();
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  } catch (err: unknown) {
    // error-policy:J1 The command boundary translates libsecret status to the store contract.
    const error = err as { stderr?: string; code?: number };
    if (isLinuxSecretToolNotFoundError(error)) {
      return { ok: false, reason: "not_found" };
    }
    return {
      ok: false,
      reason: "error",
      message: "Secret Service targeted read failed",
    };
  }
}

export function isLinuxSecretToolNotFoundError(error: {
  code?: number | string;
  stderr?: unknown;
}): boolean {
  return (
    error.code === 1 &&
    (error.stderr === undefined || String(error.stderr).trim().length === 0)
  );
}

async function clearLinuxSecret(
  service: string,
  account: string,
): Promise<void> {
  try {
    await execFileAsync(
      "secret-tool",
      ["clear", "service", service, "account", account],
      nativeExecOptions(),
    );
  } catch (error) {
    // error-policy:J1 Reset cannot succeed while a recoverable entry remains.
    if (
      isLinuxSecretToolNotFoundError(
        error as { code?: number; stderr?: unknown },
      )
    ) {
      return;
    }
    throw secureStoreOperationError(
      "SECURE_STORE_DELETE_FAILED",
      "Secret Service deletion failed",
      error,
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
        ...nativeExecOptions(),
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
        let recovered: CompatibleSecretRecoveryResult;
        try {
          recovered = await recoverCompatibleSecret({
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
          });
        } catch {
          // error-policy:J1 Compatibility discovery failures become an observable read error.
          recovered = {
            ok: false,
            reason: "error",
            message: "macOS secure-store compatibility recovery failed",
          };
        }
        const currentAfterRecovery = await readMacOSKeychainSecret(
          ELIZA_AGENT_VAULT_SERVICE,
          account,
        );
        if (
          currentAfterRecovery.ok ||
          currentAfterRecovery.reason !== "not_found"
        ) {
          return currentAfterRecovery;
        }
        if (!recovered.ok) return recovered;
        return promoteRecoveredMacOSSecret({
          recoveredValue: recovered.value,
          addOnly: async (value) => {
            await keychainSetViaStdin(
              [
                "add-generic-password",
                "-s",
                ELIZA_AGENT_VAULT_SERVICE,
                "-a",
                account,
                "-w",
              ],
              value,
            );
            macOSMetadataCache.invalidate();
          },
          readCurrent: () =>
            readMacOSKeychainSecret(ELIZA_AGENT_VAULT_SERVICE, account),
        });
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
      macOSMetadataCache.invalidate();
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
    await cleanupCurrentAndCompatibleSecret({
      deleteCurrent: () =>
        deleteMacOSKeychainSecret(ELIZA_AGENT_VAULT_SERVICE, account),
      discover: discoverMacOSKeychainMetadata,
      deleteTarget: (target) =>
        deleteMacOSKeychainSecret(
          target.service,
          target.account,
          target.locator,
        ),
      readCurrent: () =>
        readMacOSKeychainSecret(ELIZA_AGENT_VAULT_SERVICE, account),
      currentService: ELIZA_AGENT_VAULT_SERVICE,
      currentAccount: account,
      kind,
    });
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
        let recovered: CompatibleSecretRecoveryResult;
        try {
          recovered = await recoverCompatibleSecret({
            discover: discoverLinuxSecretServiceMetadata,
            read: (candidate) =>
              readLinuxSecret(candidate.service, candidate.account),
            currentService: ELIZA_AGENT_VAULT_SERVICE,
            currentAccount: account,
            kind,
          });
        } catch {
          // error-policy:J1 Compatibility discovery failures become an observable read error.
          recovered = {
            ok: false,
            reason: "error",
            message: "Secret Service compatibility recovery failed",
          };
        }
        return preferCurrentSecretAfterRecovery({
          recovered,
          readCurrent: () =>
            readLinuxSecret(ELIZA_AGENT_VAULT_SERVICE, account),
        });
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
      linuxMetadataCache.invalidate();
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
    await cleanupCurrentAndCompatibleSecret({
      deleteCurrent: () => clearLinuxSecret(ELIZA_AGENT_VAULT_SERVICE, account),
      discover: discoverLinuxSecretServiceMetadata,
      deleteTarget: (target) =>
        clearLinuxSecret(target.service, target.account),
      readCurrent: () => readLinuxSecret(ELIZA_AGENT_VAULT_SERVICE, account),
      currentService: ELIZA_AGENT_VAULT_SERVICE,
      currentAccount: account,
      kind,
    });
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
export function createNodePlatformSecureStore(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PlatformSecureStore {
  if (isMobilePlatform(env)) return new NonePlatformSecureStore();
  if (isDarwin(platform)) {
    return new MacOSKeychainPlatformSecureStore();
  }
  if (isLinux(platform)) {
    return new LinuxSecretToolPlatformSecureStore();
  }
  return new NonePlatformSecureStore();
}

export function isNodePlatformSecureStoreSupported(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isMobilePlatform(env)) return false;
  return platform === "darwin" || platform === "linux";
}

const WALLET_OS_STORE_TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const WALLET_OS_STORE_FALSE_VALUES = new Set(["0", "false", "off", "no"]);

export function isNodePlatformSecureStoreDefaultAvailable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isMobilePlatform(env)) return false;
  if (isDarwin(platform)) return true;
  if (isLinux(platform)) return secretToolOnPathSync(env.PATH);
  return false;
}

/**
 * Explicit override: `ELIZA_WALLET_OS_STORE=0|false|off|no` disables this path.
 * When unset, default on for supported local secure stores.
 */
export function isWalletOsStoreReadEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isNodePlatformSecureStoreSupported(platform, env)) return false;
  const raw = env.ELIZA_WALLET_OS_STORE?.trim().toLowerCase();
  if (raw) {
    if (WALLET_OS_STORE_TRUE_VALUES.has(raw)) return true;
    if (WALLET_OS_STORE_FALSE_VALUES.has(raw)) return false;
  }
  return isNodePlatformSecureStoreDefaultAvailable(platform, env);
}
