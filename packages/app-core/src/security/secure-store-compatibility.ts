/**
 * Recovers OS secure-store entries after a service or account namespace
 * rotation without retaining any prior product identity. Discovery reads only
 * public item metadata, selection is anchored to the stable state-directory
 * hash and secret-kind suffix, and every candidate secret read remains
 * targeted. The same structural selection powers explicit cleanup so a reset
 * cannot resurrect a predecessor entry on the next boot.
 */
import type {
  SecureStoreGetResult,
  SecureStoreSecretKind,
} from "./platform-secure-store";

const VAULT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const ACCOUNT_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const MAX_SECRET_SERVICE_COLLECTIONS = 64;
const MAX_SECRET_SERVICE_ITEMS = 4_096;

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
  token: string;
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
  if (!options.recovered.ok) return options.recovered;
  const current = await options.readCurrent();
  if (current.ok || current.reason !== "not_found") return current;
  return options.recovered;
}

function parseCompatibleAccountShape(
  account: string,
  kind: SecureStoreSecretKind,
): AccountShape | null {
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
    !ACCOUNT_PREFIX_PATTERN.test(prefix) ||
    !VAULT_TOKEN_PATTERN.test(token)
  ) {
    return null;
  }
  return { token };
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
  const compatible: Array<SecureStoreMetadataRef & AccountShape> = [];
  for (const ref of dedupeMetadataRefs(refs)) {
    if (ref.service === currentService && ref.account === currentAccount) {
      continue;
    }
    const shape = parseCompatibleAccountShape(ref.account, kind);
    if (shape) compatible.push({ ...ref, ...shape });
  }
  return compatible;
}

function withoutAccountShape(
  ref: SecureStoreMetadataRef & AccountShape,
): SecureStoreMetadataRef {
  const { token: _token, ...metadata } = ref;
  return metadata;
}

/**
 * Selects readable candidates only when their token is derivable from a state
 * root owned by this installation. Structural similarity alone is never enough
 * because another local agent may use the same secret kinds.
 */
export function selectCompatibleCandidates(
  refs: readonly SecureStoreMetadataRef[],
  currentService: string,
  currentAccount: string,
  kind: SecureStoreSecretKind,
  compatibleTokens: ReadonlySet<string>,
): CompatibleCandidateSelection {
  const structural = structurallyCompatibleRefs(
    refs,
    currentService,
    currentAccount,
    kind,
  );
  const known = structural.filter((ref) => compatibleTokens.has(ref.token));
  if (known.length === 0) return { status: "not_found" };

  const byTarget = new Map<string, SecureStoreMetadataRef[]>();
  for (const ref of known) {
    const group = byTarget.get(ref.targetId) ?? [];
    group.push(ref);
    byTarget.set(ref.targetId, group);
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
 * remove. Cleanup is deliberately stricter than read recovery: only derivable
 * state-directory tokens may be deleted, so a unique entry from another local
 * installation is never mistaken for this vault during reset.
 */
export function selectCompatibleCleanupTargets(
  refs: readonly SecureStoreMetadataRef[],
  currentService: string,
  currentAccount: string,
  kind: SecureStoreSecretKind,
  compatibleTokens: ReadonlySet<string>,
): CompatibleCandidateSelection {
  const structural = structurallyCompatibleRefs(
    refs,
    currentService,
    currentAccount,
    kind,
  );
  const known = structural.filter((ref) => compatibleTokens.has(ref.token));
  if (known.length === 0) return { status: "not_found" };

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
  compatibleTokens: ReadonlySet<string>,
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
    compatibleTokens,
  );
  if (compatible.status === "selected") {
    for (const ref of compatible.candidates) targets.set(ref.targetId, ref);
  }
  return [...targets.values()];
}

/**
 * Reads every selected target and compares normalized values. A disappearing
 * item gets one metadata rescan to tolerate concurrent cleanup; all other
 * unreadable states fail closed instead of silently choosing a survivor.
 */
export async function recoverCompatibleSecret(options: {
  discover: () => Promise<readonly SecureStoreMetadataRef[]>;
  read: (candidate: SecureStoreMetadataRef) => Promise<SecureStoreGetResult>;
  currentService: string;
  currentAccount: string;
  kind: SecureStoreSecretKind;
  compatibleTokens: ReadonlySet<string>;
}): Promise<CompatibleSecretRecoveryResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refs = await options.discover();
    const selection = selectCompatibleCandidates(
      refs,
      options.currentService,
      options.currentAccount,
      options.kind,
      options.compatibleTokens,
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
  try {
    await options.addOnly(options.recoveredValue);
    addSucceeded = true;
  } catch {
    // error-policy:J1 The exact read distinguishes a concurrent winner from add failure.
  }

  const winner = await options.readCurrent();
  if (!winner.ok) {
    return {
      ok: false,
      reason: "error",
      message: "macOS secure-store compatibility promotion failed",
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
  private droppingLongLine = false;
  private keychain: string | undefined;
  private recordClass: string | undefined;
  private account: string | undefined;
  private service: string | undefined;
  private readonly refs: SecureStoreMetadataRef[] = [];

  push(chunk: string): void {
    for (const character of chunk) {
      if (this.droppingLongLine) {
        if (character === "\n") this.droppingLongLine = false;
        continue;
      }
      if (character === "\n") {
        this.consumeLine(this.lineBuffer);
        this.lineBuffer = "";
        continue;
      }
      this.lineBuffer += character;
      if (this.lineBuffer.length > 16_384) {
        this.lineBuffer = "";
        this.droppingLongLine = true;
      }
    }
  }

  finish(): SecureStoreMetadataRef[] {
    if (!this.droppingLongLine && this.lineBuffer) {
      this.consumeLine(this.lineBuffer);
    }
    this.flushRecord();
    return dedupeMetadataRefs(this.refs);
  }

  private consumeLine(line: string): void {
    if (line.startsWith("keychain: ")) {
      this.flushRecord();
      this.keychain = parseQuotedMetadataValue(line.slice(10), false);
      return;
    }
    if (line.startsWith("class: ")) {
      this.recordClass = parseQuotedMetadataValue(line.slice(7), true);
      return;
    }
    const accountMatch = line.match(/^\s+"acct"<blob>=(.*)$/);
    if (accountMatch) {
      this.account = parseQuotedMetadataValue(accountMatch[1], true);
      return;
    }
    const serviceMatch = line.match(/^\s+"svce"<blob>=(.*)$/);
    if (serviceMatch) {
      this.service = parseQuotedMetadataValue(serviceMatch[1], true);
    }
  }

  private flushRecord(): void {
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
    this.recordClass = undefined;
    this.account = undefined;
    this.service = undefined;
  }
}

function parseQuotedMetadataValue(
  raw: string,
  asciiOnly: boolean,
): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return undefined;
  try {
    // error-policy:J3 Keychain metadata is untrusted command output.
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "string" || value.length === 0) return undefined;
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

function signatureForTypeNode(node: DbusTypeNode): string {
  if (node.type === "a") {
    if (node.child?.length !== 1) return "";
    return `a${signatureForTypeNode(node.child[0])}`;
  }
  if (node.type === "{") {
    if (node.child?.length !== 2) return "";
    return `{${node.child.map(signatureForTypeNode).join("")}}`;
  }
  return node.type;
}

function unwrapDbusVariant(value: unknown, expectedSignature: string): unknown {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Secret Service returned a malformed property variant");
  }
  const [tree, body] = value;
  if (
    !Array.isArray(tree) ||
    tree.length !== 1 ||
    signatureForTypeNode(tree[0] as DbusTypeNode) !== expectedSignature ||
    !Array.isArray(body) ||
    body.length !== 1
  ) {
    throw new Error("Secret Service returned an unexpected property type");
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
      reject(new Error("Secret Service metadata request timed out"));
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
            reject(new Error("Secret Service metadata request failed"));
            return;
          }
          resolve(result);
        },
      );
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
  return unwrapDbusVariant(value, expectedSignature);
}

function requireObjectPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "string" || !entry.startsWith("/") || entry === "/",
    )
  ) {
    throw new Error("Secret Service returned malformed object paths");
  }
  return [...new Set(value)];
}

function requireStringAttributes(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    throw new Error("Secret Service returned malformed item attributes");
  }
  const attributes: Record<string, string> = {};
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new Error("Secret Service returned malformed item attributes");
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
      throw new Error("Secret Service metadata request timed out");
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
  const collections = requireObjectPaths(collectionValue);
  if (collections.length > MAX_SECRET_SERVICE_COLLECTIONS) {
    throw new Error("Secret Service returned too many collections");
  }
  const itemPaths = new Set<string>();
  for (const collection of collections) {
    const itemsValue = await readSecretServiceProperty(
      bus,
      collection,
      "org.freedesktop.Secret.Collection",
      "Items",
      "ao",
      remainingTime(),
    );
    for (const item of requireObjectPaths(itemsValue)) {
      itemPaths.add(item);
      if (itemPaths.size > MAX_SECRET_SERVICE_ITEMS) {
        throw new Error("Secret Service returned too many items");
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
    refs.push({
      sourceId: item,
      targetId: `${service}\u0000${account}`,
      service,
      account,
    });
  }
  return dedupeMetadataRefs(refs);
}
