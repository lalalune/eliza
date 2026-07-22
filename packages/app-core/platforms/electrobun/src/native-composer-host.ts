/**
 * Durable Electrobun host for native composer operations and renderer events.
 * Custom-scheme input is text-only and never receives a filesystem capability;
 * state mutations use a versioned, bounded copy-on-write file under userData so
 * renderer acknowledgments survive process loss and cannot report false success.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";
import {
  MAX_CHAT_MEDIA_BASE64_BYTES,
  MAX_CHAT_UPLOAD_ATTACHMENTS,
} from "@elizaos/shared/chat-upload-limits";
import { logger } from "./logger";

export const NATIVE_COMPOSER_SCHEMA = "eliza.native-composer/v1" as const;
export const NATIVE_COMPOSER_STATE_SCHEMA =
  "eliza.native-composer-host-state/v1" as const;
export const MAX_NATIVE_COMPOSER_QUEUE_LENGTH = 128;

const MAX_NATIVE_COMPOSER_OPERATION_BYTES = 128 * 1024;
// A draft event can carry four contract-valid data URLs. The state cap adds a
// full operation queue so individually valid records never conflict at commit.
const MAX_NATIVE_COMPOSER_EVENT_BYTES =
  MAX_CHAT_MEDIA_BASE64_BYTES * MAX_CHAT_UPLOAD_ATTACHMENTS + 512 * 1024;
export const MAX_NATIVE_COMPOSER_STATE_BYTES =
  MAX_NATIVE_COMPOSER_EVENT_BYTES +
  MAX_NATIVE_COMPOSER_OPERATION_BYTES * MAX_NATIVE_COMPOSER_QUEUE_LENGTH +
  1024 * 1024;
const MAX_NATIVE_COMPOSER_DEEP_LINK_BYTES = 256 * 1024;
const MAX_NATIVE_COMPOSER_TEXT_LENGTH = 64 * 1024;
const MAX_NATIVE_COMPOSER_LAUNCH_ID_LENGTH = 128;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_COLLECTION_ITEMS = 1024;
const STATE_DIRECTORY_NAME = "native-composer";
const STATE_FILE_NAME = "state-v1.json";

const COMPOSER_EVENT_TYPES = [
  "draft.changed",
  "send.result",
  "focus.changed",
  "voice.state",
] as const;
const COMPOSER_EVENT_TYPE_SET = new Set<string>(COMPOSER_EVENT_TYPES);
type NativeComposerEventType = (typeof COMPOSER_EVENT_TYPES)[number];

const CHAT_ROUTES = new Set([
  "ask",
  "assistant",
  "chat",
  "chat/ask",
  "chat/smart-reply",
  "chat/voice",
  "share",
  "smart-reply",
  "voice",
]);

const TEXT_PARAMETER_NAMES = new Set(["text", "q", "query", "body"]);
const FILE_SOURCE_VALUES = new Set([
  "file",
  "filesystem",
  "inline",
  "local",
  "local-file",
]);
const NON_CUSTOM_SCHEME_PROTOCOLS = new Set([
  "about:",
  "blob:",
  "data:",
  "file:",
  "filesystem:",
  "ftp:",
  "http:",
  "https:",
  "javascript:",
  "ws:",
  "wss:",
]);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface NativeComposerOperationStream {
  schema: typeof NATIVE_COMPOSER_SCHEMA;
  operations: unknown[];
}

export interface NativeComposerRendererEventInput {
  schema: string;
  event: unknown;
}

export interface NativeComposerDelivery {
  deliveryId: string;
  operation: unknown;
}

export interface NativeComposerOperationAcknowledgmentInput {
  schema: string;
  acknowledgment: {
    deliveryId: string;
    disposition: "persisted" | "rejected";
    resultStatus: string;
    reason?: string;
  };
}

interface PersistedNativeComposerDelivery {
  deliveryId: string;
  operation: JsonValue;
}

interface PersistedNativeComposerEvent {
  type: NativeComposerEventType;
  event: JsonValue;
}

interface PersistedNativeComposerState {
  schema: typeof NATIVE_COMPOSER_STATE_SCHEMA;
  revision: number;
  operationQueue: PersistedNativeComposerDelivery[];
  latestRendererEvents: PersistedNativeComposerEvent[];
}

export type NativeComposerFileSystem = Pick<
  typeof fs,
  | "closeSync"
  | "existsSync"
  | "fsyncSync"
  | "lstatSync"
  | "mkdirSync"
  | "openSync"
  | "readFileSync"
  | "readdirSync"
  | "renameSync"
  | "unlinkSync"
  | "writeSync"
>;

export interface NativeComposerHostOptions {
  userDataDir: string;
  fileSystem?: NativeComposerFileSystem;
  randomId?: () => string;
  now?: () => number;
  platform?: NodeJS.Platform;
}

function composerError(
  message: string,
  code: string,
  options: {
    cause?: unknown;
    context?: Record<string, unknown>;
    severity?: "ephemeral" | "fatal";
  } = {},
): ElizaError {
  return new ElizaError(message, {
    code,
    cause: options.cause,
    context: options.context,
    severity: options.severity,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: string[],
): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw composerError(
      `${label} exceeds the JSON nesting limit`,
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { label, maxDepth: MAX_JSON_DEPTH },
        severity: "fatal",
      },
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw composerError(
      `${label} contains a non-finite number`,
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { label },
        severity: "fatal",
      },
    );
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_COLLECTION_ITEMS) {
      throw composerError(
        `${label} exceeds the JSON array limit`,
        "NATIVE_COMPOSER_STATE_INVALID",
        {
          context: { label, maxItems: MAX_JSON_COLLECTION_ITEMS },
          severity: "fatal",
        },
      );
    }
    for (const item of value) assertJsonValue(item, label, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) {
    throw composerError(
      `${label} must contain only JSON values`,
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { label },
        severity: "fatal",
      },
    );
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_COLLECTION_ITEMS) {
    throw composerError(
      `${label} exceeds the JSON object-key limit`,
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { label, maxKeys: MAX_JSON_COLLECTION_ITEMS },
        severity: "fatal",
      },
    );
  }
  for (const [key, item] of entries) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw composerError(
        `${label} contains a forbidden object key`,
        "NATIVE_COMPOSER_STATE_INVALID",
        {
          context: { key, label },
          severity: "fatal",
        },
      );
    }
    assertJsonValue(item, label, depth + 1);
  }
}

function normalizeBoundedJsonValue(
  value: unknown,
  label: string,
  maxBytes: number,
): JsonValue {
  assertJsonValue(value, label);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw composerError(
      `${label} must serialize to a JSON value`,
      "NATIVE_COMPOSER_STATE_INVALID",
      { context: { label }, severity: "fatal" },
    );
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > maxBytes) {
    throw composerError(
      `${label} exceeds its persisted byte limit`,
      "NATIVE_COMPOSER_STATE_TOO_LARGE",
      {
        context: { byteLength, label, maxBytes },
        severity: "fatal",
      },
    );
  }
  return JSON.parse(serialized) as JsonValue;
}

function deepLinkPath(parsed: URL): string {
  return `${parsed.host}/${parsed.pathname}`.replace(/^\/+|\/+$/g, "");
}

function decodeAsciiPercentEscapes(value: string): string {
  let decoded = value;
  for (let depth = 0; depth < 4; depth += 1) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

function isFileBearingParameter(name: string, value: string): boolean {
  const compactName = decodeAsciiPercentEscapes(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (
    /^(?:file(?:s|paths?|uris?|urls?)?|filesystem(?:paths?)?|local(?:files?|paths?|filepaths?)|absolute(?:file)?path|paths?)\d*$/.test(
      compactName,
    ) ||
    compactName.startsWith("attachment")
  ) {
    return true;
  }
  const normalizedValue = decodeAsciiPercentEscapes(value.trim()).toLowerCase();
  if (compactName === "source" && FILE_SOURCE_VALUES.has(normalizedValue)) {
    return true;
  }
  return (
    !TEXT_PARAMETER_NAMES.has(name.toLowerCase()) &&
    (normalizedValue.startsWith("file:") ||
      /["']source["']\s*:\s*["'](?:file|filesystem|inline|local|local-file)["']/.test(
        normalizedValue,
      ))
  );
}

function expectedCustomProtocol(scheme: string): string {
  const normalized = scheme.trim().replace(/:$/, "").toLowerCase();
  const protocol = `${normalized}:`;
  if (
    !/^[a-z][a-z0-9+.-]*$/.test(normalized) ||
    NON_CUSTOM_SCHEME_PROTOCOLS.has(protocol)
  ) {
    throw composerError(
      "native composer custom scheme configuration is invalid",
      "NATIVE_COMPOSER_DEEP_LINK_SCHEME_INVALID",
      { context: { scheme }, severity: "fatal" },
    );
  }
  return protocol;
}

function parseComposerDeepLink(url: string, scheme = "elizaos"): URL {
  if (Buffer.byteLength(url, "utf8") > MAX_NATIVE_COMPOSER_DEEP_LINK_BYTES) {
    throw composerError(
      "native composer deep link exceeds its byte limit",
      "NATIVE_COMPOSER_DEEP_LINK_TOO_LARGE",
      {
        context: { maxBytes: MAX_NATIVE_COMPOSER_DEEP_LINK_BYTES },
        severity: "ephemeral",
      },
    );
  }
  if (!URL.canParse(url)) {
    throw composerError(
      "native composer deep link is invalid",
      "NATIVE_COMPOSER_DEEP_LINK_INVALID",
      { severity: "ephemeral" },
    );
  }
  const parsed = new URL(url);
  const expectedProtocol = expectedCustomProtocol(scheme);
  if (parsed.protocol.toLowerCase() !== expectedProtocol) {
    throw composerError(
      "native composer accepts only the configured custom scheme",
      "NATIVE_COMPOSER_DEEP_LINK_PROTOCOL_INVALID",
      {
        context: { expectedProtocol, protocol: parsed.protocol },
        severity: "ephemeral",
      },
    );
  }
  return parsed;
}

function removeFileBearingParameters(parsed: URL): void {
  const keysToDelete = new Set<string>();
  for (const [name, value] of parsed.searchParams.entries()) {
    if (isFileBearingParameter(name, value)) keysToDelete.add(name);
  }
  for (const key of keysToDelete) parsed.searchParams.delete(key);
}

function launchText(params: URLSearchParams): string {
  for (const key of ["text", "q", "query", "body"] as const) {
    const value = params.get(key)?.trim();
    if (!value) continue;
    if (value.length > MAX_NATIVE_COMPOSER_TEXT_LENGTH) {
      throw composerError(
        "native composer text exceeds its character limit",
        "NATIVE_COMPOSER_TEXT_TOO_LARGE",
        {
          context: { maxCharacters: MAX_NATIVE_COMPOSER_TEXT_LENGTH },
          severity: "ephemeral",
        },
      );
    }
    return value;
  }
  return "";
}

function launchId(params: URLSearchParams): string {
  const value = params.get("assistant.launchId")?.trim();
  if (
    value &&
    value.length <= MAX_NATIVE_COMPOSER_LAUNCH_ID_LENGTH &&
    /^[a-zA-Z0-9._:-]+$/.test(value)
  ) {
    return value;
  }
  return randomUUID();
}

/** Remove every filesystem-bearing field before a composer URL reaches web code. */
export function sanitizeNativeComposerDeepLink(
  url: string,
  scheme = "elizaos",
): string {
  const parsed = parseComposerDeepLink(url, scheme);
  removeFileBearingParameters(parsed);
  return parsed.href;
}

/** Convert supported custom-scheme input into text, voice, and focus operations only. */
export function nativeComposerOperationsFromDeepLink(
  url: string,
  scheme = "elizaos",
): unknown[] {
  const parsed = parseComposerDeepLink(url, scheme);
  const route = deepLinkPath(parsed).toLowerCase();
  if (!CHAT_ROUTES.has(route)) return [];
  removeFileBearingParameters(parsed);

  const operationId = launchId(parsed.searchParams);
  const operations: unknown[] = [];
  const text = launchText(parsed.searchParams);
  if (text) {
    operations.push({
      type: "text.set",
      opId: `${operationId}:text`,
      text,
    });
  }
  if (route === "voice" || route === "chat/voice") {
    operations.push({
      type: "voice.handoff",
      opId: `${operationId}:voice`,
      phase: "start",
    });
  }
  if (operations.length > 0) {
    operations.push({
      type: "focus.set",
      opId: `${operationId}:focus`,
      focused: true,
      keyboard: "shown",
    });
  }
  // OS-authored input is attacker-controlled. Only an explicit in-app user
  // action may attach bytes or send; the custom scheme stops at a draft.
  return operations;
}

function emptyPersistedState(): PersistedNativeComposerState {
  return {
    schema: NATIVE_COMPOSER_STATE_SCHEMA,
    revision: 0,
    operationQueue: [],
    latestRendererEvents: [],
  };
}

function validatePersistedDelivery(
  value: unknown,
  index: number,
): PersistedNativeComposerDelivery {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["deliveryId", "operation"])
  ) {
    throw composerError(
      "native composer delivery has an invalid shape",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { index },
        severity: "fatal",
      },
    );
  }
  if (
    typeof value.deliveryId !== "string" ||
    value.deliveryId.length === 0 ||
    value.deliveryId.length > MAX_NATIVE_COMPOSER_LAUNCH_ID_LENGTH
  ) {
    throw composerError(
      "native composer delivery id is invalid",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { index },
        severity: "fatal",
      },
    );
  }
  return {
    deliveryId: value.deliveryId,
    operation: normalizeBoundedJsonValue(
      value.operation,
      `operationQueue[${index}].operation`,
      MAX_NATIVE_COMPOSER_OPERATION_BYTES,
    ),
  };
}

function validatePersistedEvent(
  value: unknown,
  index: number,
): PersistedNativeComposerEvent {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["type", "event"])) {
    throw composerError(
      "native composer renderer event has an invalid shape",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { index },
        severity: "fatal",
      },
    );
  }
  if (
    typeof value.type !== "string" ||
    !COMPOSER_EVENT_TYPE_SET.has(value.type)
  ) {
    throw composerError(
      "native composer renderer event type is invalid",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { index },
        severity: "fatal",
      },
    );
  }
  const event = normalizeBoundedJsonValue(
    value.event,
    `latestRendererEvents[${index}].event`,
    MAX_NATIVE_COMPOSER_EVENT_BYTES,
  );
  if (!isPlainRecord(event) || event.type !== value.type) {
    throw composerError(
      "native composer renderer event discriminant is invalid",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { index },
        severity: "fatal",
      },
    );
  }
  return {
    type: value.type as NativeComposerEventType,
    event,
  };
}

function validatePersistedState(value: unknown): PersistedNativeComposerState {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schema",
      "revision",
      "operationQueue",
      "latestRendererEvents",
    ]) ||
    value.schema !== NATIVE_COMPOSER_STATE_SCHEMA ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.operationQueue) ||
    !Array.isArray(value.latestRendererEvents)
  ) {
    throw composerError(
      "native composer state envelope is invalid",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { expectedSchema: NATIVE_COMPOSER_STATE_SCHEMA },
        severity: "fatal",
      },
    );
  }
  if (value.operationQueue.length > MAX_NATIVE_COMPOSER_QUEUE_LENGTH) {
    throw composerError(
      "native composer queue exceeds its persisted limit",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { maxQueueLength: MAX_NATIVE_COMPOSER_QUEUE_LENGTH },
        severity: "fatal",
      },
    );
  }
  if (value.latestRendererEvents.length > COMPOSER_EVENT_TYPES.length) {
    throw composerError(
      "native composer renderer event set exceeds its limit",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        context: { maxEventTypes: COMPOSER_EVENT_TYPES.length },
        severity: "fatal",
      },
    );
  }
  const operationQueue = value.operationQueue.map(validatePersistedDelivery);
  const latestRendererEvents = value.latestRendererEvents.map(
    validatePersistedEvent,
  );
  if (
    new Set(operationQueue.map(({ deliveryId }) => deliveryId)).size !==
      operationQueue.length ||
    new Set(latestRendererEvents.map(({ type }) => type)).size !==
      latestRendererEvents.length
  ) {
    throw composerError(
      "native composer state contains duplicate identities",
      "NATIVE_COMPOSER_STATE_INVALID",
      {
        severity: "fatal",
      },
    );
  }
  return {
    schema: NATIVE_COMPOSER_STATE_SCHEMA,
    revision: value.revision as number,
    operationQueue,
    latestRendererEvents,
  };
}

/** Crash-durable, synchronously committed state owner for the Electrobun bridge. */
export class NativeComposerHost {
  readonly userDataDirectory: string;
  readonly stateDirectory: string;
  readonly statePath: string;
  private readonly fileSystem: NativeComposerFileSystem;
  private readonly randomId: () => string;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private state: PersistedNativeComposerState;
  private unavailableError: ElizaError | null = null;

  constructor(options: NativeComposerHostOptions) {
    const userDataDir =
      typeof options.userDataDir === "string" ? options.userDataDir.trim() : "";
    if (!userDataDir || !path.isAbsolute(userDataDir)) {
      throw composerError(
        "native composer userData directory must be absolute",
        "NATIVE_COMPOSER_USER_DATA_INVALID",
        {
          context: { userDataDir },
          severity: "fatal",
        },
      );
    }
    this.fileSystem = options.fileSystem ?? fs;
    this.randomId = options.randomId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.userDataDirectory = path.resolve(userDataDir);
    this.stateDirectory = path.join(
      this.userDataDirectory,
      STATE_DIRECTORY_NAME,
    );
    this.statePath = path.join(this.stateDirectory, STATE_FILE_NAME);
    try {
      this.fileSystem.mkdirSync(this.stateDirectory, {
        recursive: true,
        mode: 0o700,
      });
      this.syncDirectory(this.userDataDirectory);
    } catch (cause) {
      // error-policy:J2 preserve the filesystem cause while adding the trusted
      // userData-derived state-directory context.
      throw composerError(
        "native composer state directory could not be made durable",
        "NATIVE_COMPOSER_STATE_DIRECTORY_FAILED",
        {
          cause,
          context: { stateDirectory: this.stateDirectory },
          severity: "fatal",
        },
      );
    }
    this.removeStaleTempFiles();
    this.state = this.loadState();
  }

  private nextId(label: string): string {
    const value = this.randomId();
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_NATIVE_COMPOSER_LAUNCH_ID_LENGTH ||
      !/^[a-zA-Z0-9._-]+$/.test(value)
    ) {
      throw composerError(
        `native composer ${label} id is invalid`,
        "NATIVE_COMPOSER_ID_INVALID",
        { context: { label }, severity: "fatal" },
      );
    }
    return value;
  }

  private removeStaleTempFiles(): void {
    let activeTempPath: string | null = null;
    let removed = false;
    try {
      for (const name of this.fileSystem.readdirSync(this.stateDirectory)) {
        if (!/^state-v1\.json\.\d+\.[a-zA-Z0-9._-]+\.tmp$/.test(name)) {
          continue;
        }
        activeTempPath = path.join(this.stateDirectory, name);
        this.fileSystem.unlinkSync(activeTempPath);
        removed = true;
        activeTempPath = null;
      }
      if (removed) this.syncStateDirectory();
    } catch (cause) {
      // error-policy:J2 stale copy-on-write artifacts are never treated as
      // committed; failure to remove one blocks startup with its exact path.
      throw composerError(
        "native composer stale state temp files could not be removed",
        "NATIVE_COMPOSER_STATE_TEMP_CLEANUP_FAILED",
        {
          cause,
          context: {
            stateDirectory: this.stateDirectory,
            tempPath: activeTempPath,
          },
          severity: "fatal",
        },
      );
    }
  }

  private loadState(): PersistedNativeComposerState {
    if (!this.fileSystem.existsSync(this.statePath))
      return emptyPersistedState();
    let stateStats: fs.Stats;
    try {
      stateStats = this.fileSystem.lstatSync(this.statePath);
    } catch (cause) {
      // error-policy:J2 preserve metadata-read failure at the state boundary.
      throw composerError(
        "native composer state metadata could not be read",
        "NATIVE_COMPOSER_STATE_READ_FAILED",
        {
          cause,
          context: { statePath: this.statePath },
          severity: "fatal",
        },
      );
    }
    if (
      !stateStats.isFile() ||
      stateStats.isSymbolicLink() ||
      stateStats.size > MAX_NATIVE_COMPOSER_STATE_BYTES
    ) {
      return this.quarantineCorruptState(
        composerError(
          "native composer state is not a bounded regular file",
          "NATIVE_COMPOSER_STATE_INVALID",
          {
            context: {
              isFile: stateStats.isFile(),
              isSymbolicLink: stateStats.isSymbolicLink(),
              maxBytes: MAX_NATIVE_COMPOSER_STATE_BYTES,
              size: stateStats.size,
            },
            severity: "fatal",
          },
        ),
      );
    }
    let raw: string;
    try {
      raw = this.fileSystem.readFileSync(this.statePath, "utf8");
    } catch (cause) {
      // error-policy:J2 preserve the filesystem cause while adding state-path context.
      throw composerError(
        "native composer state could not be read",
        "NATIVE_COMPOSER_STATE_READ_FAILED",
        {
          cause,
          context: { statePath: this.statePath },
          severity: "fatal",
        },
      );
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_NATIVE_COMPOSER_STATE_BYTES) {
      return this.quarantineCorruptState(
        composerError(
          "native composer state exceeds its byte limit",
          "NATIVE_COMPOSER_STATE_TOO_LARGE",
          {
            context: { maxBytes: MAX_NATIVE_COMPOSER_STATE_BYTES },
            severity: "fatal",
          },
        ),
      );
    }
    try {
      return validatePersistedState(JSON.parse(raw));
    } catch (cause) {
      // error-policy:J2 invalid persisted data is quarantined before the typed
      // startup failure is rethrown, preserving the validation cause.
      return this.quarantineCorruptState(cause);
    }
  }

  private quarantineCorruptState(cause: unknown): never {
    const quarantinePath = path.join(
      this.stateDirectory,
      `state-v1.corrupt.${this.now()}.${this.nextId("quarantine")}.json`,
    );
    let renamed = false;
    try {
      this.fileSystem.renameSync(this.statePath, quarantinePath);
      renamed = true;
      this.syncStateDirectory();
    } catch (quarantineCause) {
      // error-policy:J2 a failed quarantine is fatal and retains both paths
      // plus whether rename completed so the owner can recover explicitly.
      throw composerError(
        "native composer corrupt state could not be quarantined",
        "NATIVE_COMPOSER_STATE_QUARANTINE_FAILED",
        {
          cause: quarantineCause,
          context: {
            quarantinePath,
            renamed,
            statePath: this.statePath,
            validationError:
              cause instanceof Error ? cause.message : String(cause),
          },
          severity: "fatal",
        },
      );
    }
    throw composerError(
      "native composer state was corrupt and has been quarantined",
      "NATIVE_COMPOSER_STATE_CORRUPT",
      {
        cause,
        context: { quarantinePath, statePath: this.statePath },
        severity: "fatal",
      },
    );
  }

  private assertAvailable(): void {
    if (this.unavailableError) throw this.unavailableError;
  }

  private syncStateDirectory(): void {
    this.syncDirectory(this.stateDirectory);
  }

  private syncDirectory(directory: string): void {
    if (this.platform === "win32") return;
    const descriptor = this.fileSystem.openSync(directory, "r");
    try {
      this.fileSystem.fsyncSync(descriptor);
    } finally {
      this.fileSystem.closeSync(descriptor);
    }
  }

  private persist(nextState: PersistedNativeComposerState): void {
    const serialized = `${JSON.stringify(nextState)}\n`;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_NATIVE_COMPOSER_STATE_BYTES) {
      throw composerError(
        "native composer state exceeds its persisted byte limit",
        "NATIVE_COMPOSER_STATE_TOO_LARGE",
        {
          context: { byteLength, maxBytes: MAX_NATIVE_COMPOSER_STATE_BYTES },
          severity: "fatal",
        },
      );
    }

    const tempPath = path.join(
      this.stateDirectory,
      `${STATE_FILE_NAME}.${process.pid}.${this.nextId("temporary file")}.tmp`,
    );
    let descriptor: number | null = null;
    let renamed = false;
    try {
      descriptor = this.fileSystem.openSync(tempPath, "wx", 0o600);
      const bytes = Buffer.from(serialized, "utf8");
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = this.fileSystem.writeSync(
          descriptor,
          bytes,
          offset,
          bytes.byteLength - offset,
          null,
        );
        if (written <= 0) {
          throw composerError(
            "native composer state write made no progress",
            "NATIVE_COMPOSER_STATE_WRITE_FAILED",
            {
              context: { statePath: this.statePath, tempPath },
              severity: "fatal",
            },
          );
        }
        offset += written;
      }
      this.fileSystem.fsyncSync(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = null;
      this.fileSystem.renameSync(tempPath, this.statePath);
      renamed = true;
      this.syncStateDirectory();
    } catch (cause) {
      // error-policy:J2 the store is poisoned after any ambiguous durability
      // failure; callers must restart and reload the last committed file.
      const persistenceError = composerError(
        "native composer state mutation was not durably committed",
        "NATIVE_COMPOSER_STATE_WRITE_FAILED",
        {
          cause,
          context: { renamed, statePath: this.statePath, tempPath },
          severity: "fatal",
        },
      );
      this.unavailableError = persistenceError;
      if (descriptor !== null) {
        try {
          this.fileSystem.closeSync(descriptor);
        } catch (cleanupCause) {
          // error-policy:J6 descriptor cleanup is best effort after the durable
          // mutation has already failed and is surfaced to the caller.
          logger.warn(
            "[NativeComposer] Failed to close state temp file",
            cleanupCause,
          );
        }
      }
      if (!renamed && this.fileSystem.existsSync(tempPath)) {
        try {
          this.fileSystem.unlinkSync(tempPath);
        } catch (cleanupCause) {
          // error-policy:J6 temp cleanup is best effort; the write failure and
          // explicit poisoned-store state remain observable.
          logger.warn(
            "[NativeComposer] Failed to remove state temp file",
            cleanupCause,
          );
        }
      }
      throw persistenceError;
    }
  }

  private commit(nextState: PersistedNativeComposerState): void {
    this.assertAvailable();
    const validatedState = validatePersistedState(nextState);
    this.persist(validatedState);
    this.state = validatedState;
  }

  enqueue(operations: readonly unknown[]): NativeComposerOperationStream {
    this.assertAvailable();
    if (
      operations.length === 0 ||
      this.state.operationQueue.length + operations.length >
        MAX_NATIVE_COMPOSER_QUEUE_LENGTH
    ) {
      throw composerError(
        "native composer enqueue size is invalid",
        "NATIVE_COMPOSER_QUEUE_LIMIT",
        {
          context: {
            existing: this.state.operationQueue.length,
            incoming: operations.length,
            maxQueueLength: MAX_NATIVE_COMPOSER_QUEUE_LENGTH,
          },
          severity: "ephemeral",
        },
      );
    }
    const deliveries = operations.map((operation, index) => ({
      deliveryId: this.nextId("delivery"),
      operation: normalizeBoundedJsonValue(
        operation,
        `operations[${index}]`,
        MAX_NATIVE_COMPOSER_OPERATION_BYTES,
      ),
    }));
    const nextState: PersistedNativeComposerState = {
      ...this.state,
      revision: this.state.revision + 1,
      operationQueue: [...this.state.operationQueue, ...deliveries],
    };
    this.commit(nextState);
    return {
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: structuredClone(deliveries),
    };
  }

  drain(): NativeComposerOperationStream {
    this.assertAvailable();
    return {
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: structuredClone(this.state.operationQueue),
    };
  }

  acknowledge(input: NativeComposerOperationAcknowledgmentInput): {
    removed: boolean;
  } {
    this.assertAvailable();
    if (input.schema !== NATIVE_COMPOSER_SCHEMA) {
      throw composerError(
        `unsupported native composer schema: ${input.schema}`,
        "NATIVE_COMPOSER_SCHEMA_UNSUPPORTED",
        {
          context: { schema: input.schema },
          severity: "ephemeral",
        },
      );
    }
    const { acknowledgment } = input;
    if (
      !acknowledgment ||
      typeof acknowledgment.deliveryId !== "string" ||
      acknowledgment.deliveryId.length === 0 ||
      acknowledgment.deliveryId.length > MAX_NATIVE_COMPOSER_LAUNCH_ID_LENGTH ||
      (acknowledgment.disposition !== "persisted" &&
        acknowledgment.disposition !== "rejected") ||
      typeof acknowledgment.resultStatus !== "string" ||
      acknowledgment.resultStatus.length === 0 ||
      acknowledgment.resultStatus.length >
        MAX_NATIVE_COMPOSER_LAUNCH_ID_LENGTH ||
      (acknowledgment.reason !== undefined &&
        (typeof acknowledgment.reason !== "string" ||
          acknowledgment.reason.length > MAX_NATIVE_COMPOSER_TEXT_LENGTH))
    ) {
      throw composerError(
        "native composer acknowledgment is invalid",
        "NATIVE_COMPOSER_ACKNOWLEDGMENT_INVALID",
        {
          severity: "ephemeral",
        },
      );
    }
    const index = this.state.operationQueue.findIndex(
      ({ deliveryId }) => deliveryId === acknowledgment.deliveryId,
    );
    if (index < 0) return { removed: false };
    const operationQueue = [...this.state.operationQueue];
    operationQueue.splice(index, 1);
    this.commit({
      ...this.state,
      revision: this.state.revision + 1,
      operationQueue,
    });
    return { removed: true };
  }

  publish(input: NativeComposerRendererEventInput): { ok: true } {
    this.assertAvailable();
    if (input.schema !== NATIVE_COMPOSER_SCHEMA) {
      throw composerError(
        `unsupported native composer schema: ${input.schema}`,
        "NATIVE_COMPOSER_SCHEMA_UNSUPPORTED",
        {
          context: { schema: input.schema },
          severity: "ephemeral",
        },
      );
    }
    if (!isPlainRecord(input.event)) {
      throw composerError(
        "native composer event must be an object",
        "NATIVE_COMPOSER_EVENT_INVALID",
        {
          severity: "ephemeral",
        },
      );
    }
    const type = input.event.type;
    if (typeof type !== "string" || !COMPOSER_EVENT_TYPE_SET.has(type)) {
      throw composerError(
        "native composer event type is unsupported",
        "NATIVE_COMPOSER_EVENT_INVALID",
        {
          severity: "ephemeral",
        },
      );
    }
    const event = normalizeBoundedJsonValue(
      input.event,
      `renderer event ${type}`,
      MAX_NATIVE_COMPOSER_EVENT_BYTES,
    );
    const latestRendererEvents = this.state.latestRendererEvents.filter(
      (entry) => entry.type !== type,
    );
    latestRendererEvents.push({
      type: type as NativeComposerEventType,
      event,
    });
    this.commit({
      ...this.state,
      revision: this.state.revision + 1,
      latestRendererEvents,
    });
    return { ok: true };
  }

  readLatestEvent(type: string): unknown {
    this.assertAvailable();
    const event = this.state.latestRendererEvents.find(
      (entry) => entry.type === type,
    )?.event;
    return event === undefined ? undefined : structuredClone(event);
  }
}

let configuredHost: NativeComposerHost | null = null;

/** Configure the process singleton from Electrobun's trusted userData path. */
export function configureNativeComposerHost(
  options: NativeComposerHostOptions,
): NativeComposerHost {
  configuredHost = null;
  const host = new NativeComposerHost(options);
  configuredHost = host;
  return host;
}

function requireConfiguredHost(): NativeComposerHost {
  if (!configuredHost) {
    throw composerError(
      "native composer host is not configured",
      "NATIVE_COMPOSER_HOST_NOT_CONFIGURED",
      {
        severity: "fatal",
      },
    );
  }
  return configuredHost;
}

/** Persist operations before returning their cold-start delivery envelope. */
export function enqueueNativeComposerOperations(
  operations: readonly unknown[],
): NativeComposerOperationStream {
  return requireConfiguredHost().enqueue(operations);
}

/** Peek persisted operations; acknowledgment owns durable removal. */
export function drainNativeComposerOperations(): NativeComposerOperationStream {
  return requireConfiguredHost().drain();
}

/** Persist delivery removal before reporting an acknowledgment as successful. */
export function acknowledgeNativeComposerOperation(
  input: NativeComposerOperationAcknowledgmentInput,
): { removed: boolean } {
  return requireConfiguredHost().acknowledge(input);
}

/** Persist the latest renderer event before reporting publication success. */
export function publishNativeComposerEvent(
  input: NativeComposerRendererEventInput,
): { ok: true } {
  return requireConfiguredHost().publish(input);
}

export function readLatestNativeComposerEvent(type: string): unknown {
  return requireConfiguredHost().readLatestEvent(type);
}

export function resetNativeComposerHostForTests(): void {
  configuredHost = null;
}
