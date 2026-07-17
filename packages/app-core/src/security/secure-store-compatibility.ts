/**
 * Recovers OS secure-store entries after a service or account namespace
 * rotation without retaining any prior product identity. Discovery reads only
 * public item metadata, selection requires the current service and exact state
 * token, and every candidate secret read remains targeted. The same structural
 * selection powers explicit cleanup so a reset cannot resurrect a predecessor
 * entry on the next boot.
 */
import { ElizaError } from "@elizaos/core";
import type {
  SecureStoreGetResult,
  SecureStoreSecretKind,
} from "./platform-secure-store";

const VAULT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const ACCOUNT_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const MAX_ACCOUNT_PREFIX_LENGTH = 128;
const MAX_SECRET_SERVICE_COLLECTIONS = 64;
const MAX_SECRET_SERVICE_ITEMS = 4_096;
const MAX_SECRET_SERVICE_ATTRIBUTES = 64;
const MAX_SECRET_SERVICE_ATTRIBUTE_KEY_LENGTH = 128;
const MAX_SECRET_SERVICE_ATTRIBUTE_VALUE_LENGTH = 1_024;
const MAX_SECRET_SERVICE_OBJECT_PATH_LENGTH = 1_024;
const MAX_DBUS_TYPE_DEPTH = 4;
const MAX_DBUS_TYPE_NODES = 8;
const MAX_METADATA_FIELD_LENGTH = 512;
const MAX_KEYCHAIN_LOCATOR_LENGTH = 1_024;
const MAX_KEYCHAIN_DUMP_LENGTH = 4 * 1_024 * 1_024;
const MAX_KEYCHAIN_LINE_LENGTH = 16_384;
const MAX_KEYCHAIN_RECORDS = 4_096;
const MAX_COMPATIBLE_CANDIDATES = 8;

function compatibilityError(
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

export interface SecureStoreMetadataRef {
  /** Stable metadata object identity, such as a Keychain path or D-Bus item. */
  sourceId: string;
  /** Identity used by the targeted secret reader. */
  targetId: string;
  service: string;
  account: string;
  locator?: string;
}

export type CompatibleCandidateSelection =
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "selected"; candidates: SecureStoreMetadataRef[] };

export type CompatibleSecretRecoveryResult =
  | { ok: true; value: string }
  | { ok: false; reason: "not_found" | "error"; message?: string };

interface AccountShape {
  prefix: string;
  token: string;
}

/**
 * Shares a short-lived metadata snapshot across adjacent secret operations.
 * A caller can force a new native enumeration when a targeted item disappears
 * or reset needs proof from the current store state.
 */
export class SecureStoreMetadataSnapshotCache {
  private snapshot:
    | { loadedAt: number; refs: readonly SecureStoreMetadataRef[] }
    | undefined;
  private pending: Promise<readonly SecureStoreMetadataRef[]> | undefined;
  private generation = 0;

  constructor(
    private readonly load: () => Promise<readonly SecureStoreMetadataRef[]>,
    private readonly maxAgeMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw compatibilityError(
        "SECURE_STORE_METADATA_CACHE_INVALID",
        "secure-store metadata cache age is invalid",
      );
    }
  }

  async get(forceRefresh = false): Promise<readonly SecureStoreMetadataRef[]> {
    if (
      !forceRefresh &&
      this.snapshot &&
      this.now() - this.snapshot.loadedAt <= this.maxAgeMs
    ) {
      return this.snapshot.refs;
    }
    if (!forceRefresh && this.pending) return this.pending;

    if (forceRefresh) this.snapshot = undefined;
    const generation = ++this.generation;
    const pending = this.load().then((refs) => {
      const snapshot = Object.freeze(
        refs.map((ref) => Object.freeze({ ...ref })),
      );
      if (generation === this.generation) {
        this.snapshot = { loadedAt: this.now(), refs: snapshot };
      }
      return snapshot;
    });
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  invalidate(): void {
    this.generation += 1;
    this.snapshot = undefined;
    this.pending = undefined;
  }
}

/** Exact current storage is authoritative; compatibility is a not-found path. */
export async function readCurrentOrRecover(options: {
  readCurrent: () => Promise<SecureStoreGetResult>;
  recover: () => Promise<SecureStoreGetResult>;
}): Promise<SecureStoreGetResult> {
  const current = await options.readCurrent();
  if (current.ok || current.reason !== "not_found") return current;
  return options.recover();
}

/**
 * Resolves the race between compatibility discovery and a concurrent exact
 * write. A current value or current-read error wins; the recovered value is
 * usable only while the exact account remains absent.
 */
export async function preferCurrentSecretAfterRecovery(options: {
  recovered: CompatibleSecretRecoveryResult;
  readCurrent: () => Promise<SecureStoreGetResult>;
}): Promise<SecureStoreGetResult> {
  const current = await options.readCurrent();
  if (current.ok || current.reason !== "not_found") return current;
  return options.recovered;
}

function parseCompatibleAccountShape(
  account: string,
  kind: SecureStoreSecretKind,
): AccountShape | null {
  if (account.length > MAX_METADATA_FIELD_LENGTH) return null;
  const kindSuffix = `:${kind}`;
  if (!account.endsWith(kindSuffix)) return null;

  const namespaceAndToken = account.slice(0, -kindSuffix.length);
  const tokenSeparator = namespaceAndToken.length - 17;
  if (tokenSeparator <= 0 || namespaceAndToken[tokenSeparator] !== "-") {
    return null;
  }

  const prefix = namespaceAndToken.slice(0, tokenSeparator);
  const token = namespaceAndToken.slice(tokenSeparator + 1);
  if (
    prefix.length > MAX_ACCOUNT_PREFIX_LENGTH ||
    !ACCOUNT_PREFIX_PATTERN.test(prefix) ||
    !VAULT_TOKEN_PATTERN.test(token)
  ) {
    return null;
  }
  return { prefix, token };
}

function dedupeMetadataRefs(
  refs: readonly SecureStoreMetadataRef[],
): SecureStoreMetadataRef[] {
  const bySource = new Map<string, SecureStoreMetadataRef>();
  for (const ref of refs) {
    const identity = `${ref.sourceId}\u0000${ref.service}\u0000${ref.account}`;
    if (!bySource.has(identity)) bySource.set(identity, ref);
  }
  return [...bySource.values()];
}

function structurallyCompatibleRefs(
  refs: readonly SecureStoreMetadataRef[],
  currentService: string,
  currentAccount: string,
  kind: SecureStoreSecretKind,
): Array<SecureStoreMetadataRef & AccountShape> {
  const currentShape = parseCompatibleAccountShape(currentAccount, kind);
  if (!currentShape) {
    throw compatibilityError(
      "SECURE_STORE_CURRENT_ACCOUNT_INVALID",
      "current secure-store account is malformed",
    );
  }
  const compatible: Array<SecureStoreMetadataRef & AccountShape> = [];
  for (const ref of dedupeMetadataRefs(refs)) {
    if (ref.service !== currentService || ref.account === currentAccount)
      continue;
    const shape = parseCompatibleAccountShape(ref.account, kind);
    if (
      shape &&
      shape.token === currentShape.token &&
      shape.prefix !== currentShape.prefix
    ) {
      compatible.push({ ...ref, ...shape });
    }
  }
  return compatible;
}

function withoutAccountShape(
  ref: SecureStoreMetadataRef & AccountShape,
): SecureStoreMetadataRef {
  const { prefix: _prefix, token: _token, ...metadata } = ref;
  return metadata;
}

/**
 * Selects readable predecessors only under the current service and state token.
 * A different service or token belongs to a different installation even when
 * its account has the same shape and secret-kind suffix.
 */
export function selectCompatibleCandidates(
  refs: readonly SecureStoreMetadataRef[],
  currentService: string,
  currentAccount: string,
  kind: SecureStoreSecretKind,
): CompatibleCandidateSelection {
  const known = structurallyCompatibleRefs(
    refs,
    currentService,
    currentAccount,
    kind,
  );
  if (known.length === 0) return { status: "not_found" };
  if (known.length > MAX_COMPATIBLE_CANDIDATES) {
    return { status: "ambiguous" };
  }

  const byTarget = new Map<string, SecureStoreMetadataRef[]>();
  for (const ref of known) {
    const group = byTarget.get(ref.targetId);
    if (group) {
      group.push(ref);
    } else {
      byTarget.set(ref.targetId, [ref]);
    }
  }

  if ([...byTarget.values()].some((group) => group.length !== 1)) {
    return { status: "ambiguous" };
  }
  return {
    status: "selected",
    candidates: known.map(withoutAccountShape),
  };
}

/**
 * Returns every structurally compatible target that explicit reset must
 * remove. The current service and exact state token constrain deletion so an
 * entry from another local installation is never mistaken for this vault.
 */
export function selectCompatibleCleanupTargets(
  refs: readonly SecureStoreMetadataRef[],
  currentService: string,
  currentAccount: string,
  kind: SecureStoreSecretKind,
): CompatibleCandidateSelection {
  const known = structurallyCompatibleRefs(
    refs,
    currentService,
    currentAccount,
    kind,
  );
  if (known.length === 0) return { status: "not_found" };
  if (known.length > MAX_COMPATIBLE_CANDIDATES) {
    return { status: "ambiguous" };
  }

  const byTarget = new Map<string, SecureStoreMetadataRef & AccountShape>();
  for (const ref of known) {
    if (!byTarget.has(ref.targetId)) byTarget.set(ref.targetId, ref);
  }
  return {
    status: "selected",
    candidates: [...byTarget.values()].map(withoutAccountShape),
  };
}

/** Exact current metadata and every derived predecessor targeted by reset. */
export function collectSecureStoreCleanupTargets(
  refs: readonly SecureStoreMetadataRef[],
  currentService: string,
  currentAccount: string,
  kind: SecureStoreSecretKind,
): SecureStoreMetadataRef[] {
  const targets = new Map<string, SecureStoreMetadataRef>();
  for (const ref of dedupeMetadataRefs(refs)) {
    if (ref.service === currentService && ref.account === currentAccount) {
      targets.set(ref.targetId, ref);
    }
  }
  const compatible = selectCompatibleCleanupTargets(
    refs,
    currentService,
    currentAccount,
    kind,
  );
  if (compatible.status === "ambiguous") {
    throw compatibilityError(
      "SECURE_STORE_CLEANUP_TARGET_LIMIT_EXCEEDED",
      "secure-store cleanup found too many predecessor targets",
    );
  }
  if (compatible.status === "selected") {
    for (const ref of compatible.candidates) targets.set(ref.targetId, ref);
  }
  return [...targets.values()];
}

/**
 * Deletes the exact account before metadata-discovered predecessors, then
 * verifies both the targeted current read and a forced-fresh metadata view.
 * Reset callers must finish this sequence before deleting their vault copy.
 */
export async function cleanupCurrentAndCompatibleSecret(options: {
  deleteCurrent: () => Promise<void>;
  discover: (
    forceRefresh: boolean,
  ) => Promise<readonly SecureStoreMetadataRef[]>;
  deleteTarget: (target: SecureStoreMetadataRef) => Promise<void>;
  readCurrent: () => Promise<SecureStoreGetResult>;
  currentService: string;
  currentAccount: string;
  kind: SecureStoreSecretKind;
}): Promise<void> {
  await options.deleteCurrent();
  const targets = collectSecureStoreCleanupTargets(
    await options.discover(true),
    options.currentService,
    options.currentAccount,
    options.kind,
  );
  for (const target of targets) await options.deleteTarget(target);

  const current = await options.readCurrent();
  if (current.ok || current.reason !== "not_found") {
    throw compatibilityError(
      "SECURE_STORE_DELETE_INCOMPLETE",
      "secure-store cleanup could not verify exact deletion",
    );
  }
  if (
    collectSecureStoreCleanupTargets(
      await options.discover(true),
      options.currentService,
      options.currentAccount,
      options.kind,
    ).length > 0
  ) {
    throw compatibilityError(
      "SECURE_STORE_DELETE_INCOMPLETE",
      "secure-store cleanup verification found a recoverable entry",
    );
  }
}

/**
 * Reads every selected target and compares normalized values. A disappearing
 * item gets one metadata rescan to tolerate concurrent cleanup; all other
 * unreadable states fail closed instead of silently choosing a survivor.
 */
export async function recoverCompatibleSecret(options: {
  discover: (
    forceRefresh: boolean,
  ) => Promise<readonly SecureStoreMetadataRef[]>;
  read: (candidate: SecureStoreMetadataRef) => Promise<SecureStoreGetResult>;
  currentService: string;
  currentAccount: string;
  kind: SecureStoreSecretKind;
}): Promise<CompatibleSecretRecoveryResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refs = await options.discover(attempt > 0);
    const selection = selectCompatibleCandidates(
      refs,
      options.currentService,
      options.currentAccount,
      options.kind,
    );
    if (selection.status === "not_found") {
      return { ok: false, reason: "not_found" };
    }
    if (selection.status === "ambiguous") {
      return {
        ok: false,
        reason: "error",
        message: "secure-store compatibility metadata is ambiguous",
      };
    }

    const values = new Set<string>();
    let candidateDisappeared = false;
    for (const candidate of selection.candidates) {
      const result = await options.read(candidate);
      if (!result.ok) {
        if (result.reason === "not_found") {
          candidateDisappeared = true;
          break;
        }
        return {
          ok: false,
          reason: "error",
          message: "a compatible secure-store entry is unreadable",
        };
      }
      const normalized = result.value.trim();
      if (!normalized) {
        return {
          ok: false,
          reason: "error",
          message: "a compatible secure-store entry is empty",
        };
      }
      values.add(normalized);
    }

    if (candidateDisappeared) {
      if (attempt === 0) continue;
      return {
        ok: false,
        reason: "error",
        message: "secure-store compatibility metadata changed during recovery",
      };
    }
    if (values.size !== 1) {
      return {
        ok: false,
        reason: "error",
        message: "compatible secure-store entries contain divergent values",
      };
    }
    return { ok: true, value: [...values][0] };
  }

  return {
    ok: false,
    reason: "error",
    message: "secure-store compatibility recovery did not settle",
  };
}

/**
 * Promotes a recovered macOS value with add-if-absent semantics. The exact
 * account is always reread: successful adds must verify byte-for-byte, while a
 * failed add may mean a concurrent writer won and that writer is authoritative.
 */
export async function promoteRecoveredMacOSSecret(options: {
  recoveredValue: string;
  addOnly: (value: string) => Promise<void>;
  readCurrent: () => Promise<SecureStoreGetResult>;
}): Promise<SecureStoreGetResult> {
  let addSucceeded = false;
  let addFailure: unknown;
  try {
    await options.addOnly(options.recoveredValue);
    addSucceeded = true;
  } catch (error) {
    // error-policy:J1 The exact read distinguishes a concurrent winner from add failure.
    addFailure = error;
  }

  const winner = await options.readCurrent();
  if (!winner.ok) {
    if (winner.reason !== "not_found") return winner;
    return {
      ok: false,
      reason: "error",
      message:
        addFailure instanceof Error
          ? `macOS secure-store compatibility promotion failed: ${addFailure.message}`
          : "macOS secure-store compatibility promotion failed",
    };
  }
  if (addSucceeded && winner.value !== options.recoveredValue) {
    return {
      ok: false,
      reason: "error",
      message: "macOS secure-store compatibility promotion did not verify",
    };
  }
  return winner;
}

/**
 * macOS emits one generic-password record at a time. This parser accepts
 * arbitrary stream chunking and retains only the account, service, and
 * keychain path needed for a later targeted read.
 */
export class MacOSKeychainMetadataParser {
  private lineBuffer = "";
  private totalLength = 0;
  private recordsSeen = 0;
  private keychain: string | undefined;
  private recordClass: string | undefined;
  private account: string | undefined;
  private service: string | undefined;
  private readonly refs: SecureStoreMetadataRef[] = [];

  push(chunk: string): void {
    this.totalLength += chunk.length;
    if (this.totalLength > MAX_KEYCHAIN_DUMP_LENGTH) {
      throw compatibilityError(
        "SECURE_STORE_KEYCHAIN_DUMP_LIMIT_EXCEEDED",
        "macOS secure-store metadata exceeded its size limit",
      );
    }
    for (const character of chunk) {
      if (character === "\n") {
        this.consumeLine(this.lineBuffer);
        this.lineBuffer = "";
        continue;
      }
      this.lineBuffer += character;
      if (this.lineBuffer.length > MAX_KEYCHAIN_LINE_LENGTH) {
        throw compatibilityError(
          "SECURE_STORE_KEYCHAIN_LINE_LIMIT_EXCEEDED",
          "macOS secure-store metadata line exceeded its size limit",
        );
      }
    }
  }

  finish(): SecureStoreMetadataRef[] {
    if (this.lineBuffer) this.consumeLine(this.lineBuffer);
    this.flushRecord();
    return dedupeMetadataRefs(this.refs);
  }

  private consumeLine(line: string): void {
    if (line.startsWith("keychain: ")) {
      this.flushRecord();
      const locator = parseQuotedMetadataValue(
        line.slice(10),
        false,
        MAX_KEYCHAIN_LOCATOR_LENGTH,
      );
      this.keychain = locator?.startsWith("/") ? locator : undefined;
      return;
    }
    if (line.startsWith("class: ")) {
      this.recordClass = parseQuotedMetadataValue(line.slice(7), true, 16);
      return;
    }
    const accountMatch = line.match(/^\s+"acct"<blob>=(.*)$/);
    if (accountMatch) {
      this.account = parseQuotedMetadataValue(
        accountMatch[1],
        true,
        MAX_METADATA_FIELD_LENGTH,
      );
      return;
    }
    const serviceMatch = line.match(/^\s+"svce"<blob>=(.*)$/);
    if (serviceMatch) {
      this.service = parseQuotedMetadataValue(
        serviceMatch[1],
        true,
        MAX_METADATA_FIELD_LENGTH,
      );
    }
  }

  private flushRecord(): void {
    if (this.keychain) {
      this.recordsSeen += 1;
      if (this.recordsSeen > MAX_KEYCHAIN_RECORDS) {
        throw compatibilityError(
          "SECURE_STORE_KEYCHAIN_RECORD_LIMIT_EXCEEDED",
          "macOS secure-store metadata contained too many records",
        );
      }
    }
    if (
      this.recordClass === "genp" &&
      this.keychain &&
      this.account &&
      this.service
    ) {
      const sourceId = `${this.keychain}\u0000${this.service}\u0000${this.account}`;
      this.refs.push({
        sourceId,
        targetId: sourceId,
        service: this.service,
        account: this.account,
        locator: this.keychain,
      });
    }
    this.keychain = undefined;
    this.recordClass = undefined;
    this.account = undefined;
    this.service = undefined;
  }
}

function parseQuotedMetadataValue(
  raw: string,
  asciiOnly: boolean,
  maxLength: number,
): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return undefined;
  try {
    // error-policy:J3 Keychain metadata is untrusted command output.
    const value: unknown = JSON.parse(trimmed);
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maxLength
    ) {
      return undefined;
    }
    if (asciiOnly && !/^[\x20-\x7e]+$/.test(value)) return undefined;
    return value;
  } catch {
    // error-policy:J3 Invalid metadata records are excluded, never treated as candidates.
    return undefined;
  }
}

interface DbusError {
  name?: string;
  message?: unknown;
}

export interface SecretServiceMetadataBus {
  invoke(
    message: {
      destination: string;
      path: string;
      interface: string;
      member: string;
      signature: "ss";
      body: [string, string];
    },
    callback: (error: DbusError | undefined | null, value?: unknown) => void,
  ): void;
}

interface DbusTypeNode {
  type: string;
  child?: DbusTypeNode[];
}

function signatureForTypeNode(
  value: unknown,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_SIGNATURE_INVALID",
      "Secret Service returned a malformed property type",
    );
  }
  if (depth > MAX_DBUS_TYPE_DEPTH) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_SIGNATURE_DEPTH_EXCEEDED",
      "Secret Service property type exceeded its depth limit",
    );
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_DBUS_TYPE_NODES) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_SIGNATURE_LIMIT_EXCEEDED",
      "Secret Service property type exceeded its node limit",
    );
  }

  const node = value as Partial<DbusTypeNode>;
  if (
    typeof node.type !== "string" ||
    !["a", "{", "o", "s"].includes(node.type)
  ) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_SIGNATURE_UNSUPPORTED",
      "Secret Service returned an unsupported property type",
    );
  }
  const children = node.child;
  if (!Array.isArray(children)) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_SIGNATURE_INVALID",
      "Secret Service returned a malformed property type",
    );
  }
  if (node.type === "a") {
    if (children.length !== 1) {
      throw compatibilityError(
        "SECURE_STORE_DBUS_SIGNATURE_INVALID",
        "Secret Service returned a malformed array property type",
      );
    }
    return `a${signatureForTypeNode(children[0], depth + 1, budget)}`;
  }
  if (node.type === "{") {
    if (children.length !== 2) {
      throw compatibilityError(
        "SECURE_STORE_DBUS_SIGNATURE_INVALID",
        "Secret Service returned a malformed dictionary property type",
      );
    }
    return `{${children
      .map((child) => signatureForTypeNode(child, depth + 1, budget))
      .join("")}}`;
  }
  if (children.length !== 0) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_SIGNATURE_INVALID",
      "Secret Service returned a malformed scalar property type",
    );
  }
  return node.type;
}

function unwrapDbusVariant(value: unknown, expectedSignature: string): unknown {
  if (!Array.isArray(value) || value.length !== 2) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_VARIANT_INVALID",
      "Secret Service returned a malformed property variant",
    );
  }
  const [tree, body] = value;
  if (
    !Array.isArray(tree) ||
    tree.length !== 1 ||
    signatureForTypeNode(tree[0]) !== expectedSignature ||
    !Array.isArray(body) ||
    body.length !== 1
  ) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_VARIANT_TYPE_INVALID",
      "Secret Service returned an unexpected property type",
    );
  }
  return body[0];
}

async function readSecretServiceProperty(
  bus: SecretServiceMetadataBus,
  path: string,
  ownerInterface: string,
  property: string,
  expectedSignature: "ao" | "a{ss}",
  timeoutMs: number,
): Promise<unknown> {
  const value = await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        compatibilityError(
          "SECURE_STORE_DBUS_REQUEST_TIMEOUT",
          "Secret Service metadata request timed out",
        ),
      );
    }, timeoutMs);
    try {
      bus.invoke(
        {
          destination: "org.freedesktop.secrets",
          path,
          interface: "org.freedesktop.DBus.Properties",
          member: "Get",
          signature: "ss",
          body: [ownerInterface, property],
        },
        (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            reject(
              compatibilityError(
                "SECURE_STORE_DBUS_REQUEST_FAILED",
                "Secret Service metadata request failed",
              ),
            );
            return;
          }
          resolve(result);
        },
      );
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(
        compatibilityError(
          "SECURE_STORE_DBUS_INVOKE_FAILED",
          "Secret Service metadata invocation failed",
          error,
        ),
      );
    }
  });
  return unwrapDbusVariant(value, expectedSignature);
}

function requireObjectPaths(
  value: unknown,
  maxEntries: number,
  label: "collections" | "items",
): string[] {
  if (Array.isArray(value) && value.length > maxEntries) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_PATH_LIMIT_EXCEEDED",
      `Secret Service returned too many ${label}`,
    );
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length > MAX_SECRET_SERVICE_OBJECT_PATH_LENGTH ||
        !/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)$/.test(entry),
    )
  ) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_PATH_INVALID",
      "Secret Service returned malformed object paths",
    );
  }
  return [...new Set(value)];
}

function requireStringAttributes(value: unknown): Record<string, string> {
  if (Array.isArray(value) && value.length > MAX_SECRET_SERVICE_ATTRIBUTES) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_ATTRIBUTE_LIMIT_EXCEEDED",
      "Secret Service returned too many item attributes",
    );
  }
  if (!Array.isArray(value)) {
    throw compatibilityError(
      "SECURE_STORE_DBUS_ATTRIBUTES_INVALID",
      "Secret Service returned malformed item attributes",
    );
  }
  const attributes: Record<string, string> = {};
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      entry[0].length === 0 ||
      entry[0].length > MAX_SECRET_SERVICE_ATTRIBUTE_KEY_LENGTH ||
      entry[1].length > MAX_SECRET_SERVICE_ATTRIBUTE_VALUE_LENGTH ||
      !/^[\x20-\x7e]+$/.test(entry[0]) ||
      entry[1].includes("\u0000") ||
      Object.hasOwn(attributes, entry[0])
    ) {
      throw compatibilityError(
        "SECURE_STORE_DBUS_ATTRIBUTES_INVALID",
        "Secret Service returned malformed item attributes",
      );
    }
    attributes[entry[0]] = entry[1];
  }
  return attributes;
}

/**
 * Enumerates Secret Service lookup attributes through Properties.Get only.
 * Secrets, sessions, and unlock prompts are deliberately outside this path.
 */
export async function enumerateSecretServiceMetadata(
  bus: SecretServiceMetadataBus,
  timeoutMs = 5_000,
): Promise<SecureStoreMetadataRef[]> {
  const deadline = Date.now() + timeoutMs;
  const remainingTime = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw compatibilityError(
        "SECURE_STORE_DBUS_REQUEST_TIMEOUT",
        "Secret Service metadata request timed out",
      );
    }
    return remaining;
  };
  const collectionValue = await readSecretServiceProperty(
    bus,
    "/org/freedesktop/secrets",
    "org.freedesktop.Secret.Service",
    "Collections",
    "ao",
    remainingTime(),
  );
  const collections = requireObjectPaths(
    collectionValue,
    MAX_SECRET_SERVICE_COLLECTIONS,
    "collections",
  );
  const itemPaths = new Set<string>();
  let rawItemEntries = 0;
  for (const collection of collections) {
    const itemsValue = await readSecretServiceProperty(
      bus,
      collection,
      "org.freedesktop.Secret.Collection",
      "Items",
      "ao",
      remainingTime(),
    );
    if (Array.isArray(itemsValue)) {
      rawItemEntries += itemsValue.length;
      if (rawItemEntries > MAX_SECRET_SERVICE_ITEMS) {
        throw compatibilityError(
          "SECURE_STORE_DBUS_PATH_LIMIT_EXCEEDED",
          "Secret Service returned too many items",
        );
      }
    }
    for (const item of requireObjectPaths(
      itemsValue,
      MAX_SECRET_SERVICE_ITEMS,
      "items",
    )) {
      itemPaths.add(item);
      if (itemPaths.size > MAX_SECRET_SERVICE_ITEMS) {
        throw compatibilityError(
          "SECURE_STORE_DBUS_PATH_LIMIT_EXCEEDED",
          "Secret Service returned too many items",
        );
      }
    }
  }

  const refs: SecureStoreMetadataRef[] = [];
  for (const item of itemPaths) {
    const attributesValue = await readSecretServiceProperty(
      bus,
      item,
      "org.freedesktop.Secret.Item",
      "Attributes",
      "a{ss}",
      remainingTime(),
    );
    const attributes = requireStringAttributes(attributesValue);
    const service = attributes.service;
    const account = attributes.account;
    if (!service || !account) continue;
    if (
      service.length > MAX_METADATA_FIELD_LENGTH ||
      account.length > MAX_METADATA_FIELD_LENGTH ||
      !/^[\x20-\x7e]+$/.test(service) ||
      !/^[\x20-\x7e]+$/.test(account)
    ) {
      throw compatibilityError(
        "SECURE_STORE_METADATA_FIELD_INVALID",
        "Secret Service returned invalid lookup attributes",
      );
    }
    refs.push({
      sourceId: item,
      targetId: `${service}\u0000${account}`,
      service,
      account,
    });
  }
  return dedupeMetadataRefs(refs);
}
