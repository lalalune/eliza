/**
 * The renderer-side composer-bridge client: the one object a native shell talks
 * to. It decodes raw operations at the boundary, folds them through the reducer,
 * emits typed {@link ComposerEvent}s back to the shell, and exposes a durable
 * snapshot of the draft + idempotency ledger for a host persistence adapter.
 *
 * Durability model:
 *   - `serialize()` / `hydrate()` round-trip the draft, the processed-`opId`
 *     ledger, and the offline send queue as plain JSON. Restoring them after a
 *     reload is what makes a re-delivered operation still dedupe (idempotency)
 *     and an offline send still replay (offline recovery). The in-flight
 *     `sending` marker becomes a deferred send in the snapshot — a reload has no
 *     live request to resume, so the same idempotent operation must be re-driven.
 *   - `setOnline(true)` flushes the deferred queue and reports each replay.
 *
 * The client never throws on bad native input: a malformed raw operation becomes
 * a `rejected: "invalid-input"` result (error-policy J3), so one bad frame cannot
 * tear down a live composer.
 */

import { normalizeComposerAttachment } from "./attachments";
import {
  type ComposerAttachment,
  type ComposerDraft,
  type ComposerEvent,
  type ComposerMention,
  type ComposerOperation,
  type ComposerReplyContext,
  type DispatchResult,
  NATIVE_COMPOSER_SCHEMA,
  type NativeComposerSchema,
  type SendOutcome,
} from "./contract";
import {
  decodeComposerOperation,
  decodeComposerOperationStream,
} from "./decode";
import {
  applyComposerOperation,
  type ComposerApplyContext,
  type ComposerBridgeState,
  type ComposerCapabilities,
  type ComposerLimits,
  DEFAULT_COMPOSER_CAPABILITIES,
  DEFAULT_COMPOSER_LIMITS,
  type DeferredComposerSend,
  flushDeferredOperations,
  initialComposerState,
  resolveSend,
} from "./reduce";

/** Plain-JSON snapshot persisted across reload; excludes the transient send. */
export interface ComposerBridgeSnapshot {
  schema: NativeComposerSchema;
  draft: ComposerDraft;
  /** The dedupe ledger, so a post-reload duplicate op still no-ops. */
  processedOpIds: string[];
  /** The offline send queue, so a deferred send still replays after reload. */
  deferred: DeferredComposerSend[];
}

export interface ComposerBridgeClientOptions {
  online?: boolean;
  capabilities?: ComposerCapabilities;
  limits?: ComposerLimits;
  /** Restore a prior session (idempotency + draft + offline queue). */
  snapshot?: ComposerBridgeSnapshot;
}

export interface ComposerBridgeClient {
  /** Decode + apply one raw native operation; never throws on bad input. */
  dispatchRaw(raw: unknown): DispatchResult;
  /** Decode + apply a whole `{ schema, operations }` envelope (batch replay). */
  dispatchRawStream(raw: unknown): DispatchResult[];
  /** Apply an already-decoded operation. */
  dispatchOperation(op: ComposerOperation): DispatchResult;
  /** Resolve the in-flight send and emit `send.result` + `draft.changed`. */
  completeSend(opId: string, outcome: SendOutcome): void;
  /** Toggle transport liveness; going online flushes the deferred send queue. */
  setOnline(online: boolean): void;
  getDraft(): ComposerDraft;
  getState(): ComposerBridgeState;
  /** Subscribe to events emitted toward the native shell. */
  subscribe(listener: (event: ComposerEvent) => void): () => void;
  serialize(): ComposerBridgeSnapshot;
}

export type ComposerBridgeSnapshotDecodeResult =
  | { ok: true; snapshot: ComposerBridgeSnapshot }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalNonEmptyStringIsValid(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return (
    !(key in record) ||
    record[key] === undefined ||
    isNonEmptyString(record[key])
  );
}

function decodeSnapshotAttachment(
  raw: unknown,
  limits: ComposerLimits,
): ComposerAttachment | null {
  if (!isRecord(raw)) return null;
  if (
    !isNonEmptyString(raw.id) ||
    raw.id.length > limits.maxIdLength ||
    !isNonEmptyString(raw.url)
  )
    return null;
  if (!optionalNonEmptyStringIsValid(raw, "mimeType")) return null;
  if (!optionalNonEmptyStringIsValid(raw, "name")) return null;
  if (raw.kind !== "inline" && raw.kind !== "remote" && raw.kind !== "stored")
    return null;
  if (raw.status !== "ready" && raw.status !== "pending-rehost") return null;
  const attachment: ComposerAttachment = {
    id: raw.id,
    url: raw.url,
    kind: raw.kind,
    status: raw.status,
    ...(isNonEmptyString(raw.mimeType) ? { mimeType: raw.mimeType } : {}),
    ...(isNonEmptyString(raw.name) ? { name: raw.name } : {}),
  };
  const source =
    attachment.kind === "inline"
      ? {
          source: "data-url" as const,
          dataUrl: attachment.url,
          ...(attachment.name ? { name: attachment.name } : {}),
        }
      : {
          source: attachment.kind,
          url: attachment.url,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.name ? { name: attachment.name } : {}),
        };
  if (
    attachment.kind !== "inline" &&
    attachment.url.length > limits.maxRemoteUrlLength
  )
    return null;
  const normalized = normalizeComposerAttachment(attachment.id, source, {
    maxBytes: limits.maxAttachmentBytes,
  });
  if (!normalized.ok) return null;
  const canonical = normalized.attachment;
  if (
    canonical.url !== attachment.url ||
    canonical.kind !== attachment.kind ||
    canonical.status !== attachment.status ||
    canonical.mimeType !== attachment.mimeType ||
    canonical.name !== attachment.name
  )
    return null;
  return attachment;
}

function decodeSnapshotReply(
  raw: unknown,
  limits: ComposerLimits,
): ComposerReplyContext | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.messageId) ||
    raw.messageId.length > limits.maxIdLength
  )
    return null;
  if (!optionalNonEmptyStringIsValid(raw, "authorId")) return null;
  if (
    isNonEmptyString(raw.authorId) &&
    raw.authorId.length > limits.maxIdLength
  )
    return null;
  if (
    "preview" in raw &&
    raw.preview !== undefined &&
    typeof raw.preview !== "string"
  )
    return null;
  if (
    typeof raw.preview === "string" &&
    raw.preview.length > limits.maxMetadataLength
  )
    return null;
  return {
    messageId: raw.messageId,
    ...(isNonEmptyString(raw.authorId) ? { authorId: raw.authorId } : {}),
    ...(typeof raw.preview === "string" ? { preview: raw.preview } : {}),
  };
}

function decodeSnapshotMention(
  raw: unknown,
  limits: ComposerLimits,
): ComposerMention | null {
  if (!isRecord(raw)) return null;
  if (
    !isNonEmptyString(raw.id) ||
    raw.id.length > limits.maxIdLength ||
    typeof raw.label !== "string" ||
    raw.label.length > limits.maxMetadataLength
  )
    return null;
  if (
    "kind" in raw &&
    raw.kind !== undefined &&
    raw.kind !== "user" &&
    raw.kind !== "agent" &&
    raw.kind !== "channel"
  )
    return null;
  return {
    id: raw.id,
    label: raw.label,
    ...(raw.kind === "user" || raw.kind === "agent" || raw.kind === "channel"
      ? { kind: raw.kind }
      : {}),
  };
}

function decodeSnapshotDraft(
  raw: unknown,
  limits: ComposerLimits,
): ComposerDraft | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.text !== "string" || raw.text.length > limits.maxTextLength)
    return null;
  if (!Array.isArray(raw.attachments) || !Array.isArray(raw.mentions))
    return null;
  if (
    raw.attachments.length > limits.maxAttachments ||
    raw.mentions.length > limits.maxMentions
  )
    return null;
  if (typeof raw.focused !== "boolean") return null;
  if (raw.keyboard !== "shown" && raw.keyboard !== "hidden") return null;
  if (
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0
  )
    return null;

  const attachments: ComposerAttachment[] = [];
  for (const attachment of raw.attachments) {
    const decoded = decodeSnapshotAttachment(attachment, limits);
    if (!decoded) return null;
    attachments.push(decoded);
  }
  const mentions: ComposerMention[] = [];
  for (const mention of raw.mentions) {
    const decoded = decodeSnapshotMention(mention, limits);
    if (!decoded) return null;
    mentions.push(decoded);
  }
  const reply =
    raw.reply === null ? null : decodeSnapshotReply(raw.reply, limits);
  if (raw.reply !== null && !reply) return null;
  return {
    text: raw.text,
    attachments,
    reply,
    mentions,
    focused: raw.focused,
    keyboard: raw.keyboard,
    revision: raw.revision,
  };
}

/** Validate the local durable snapshot before it reaches the trusted reducer. */
export function decodeComposerBridgeSnapshot(
  raw: unknown,
  limits: ComposerLimits = DEFAULT_COMPOSER_LIMITS,
): ComposerBridgeSnapshotDecodeResult {
  if (!isRecord(raw))
    return { ok: false, message: "snapshot must be an object" };
  if (raw.schema !== NATIVE_COMPOSER_SCHEMA)
    return { ok: false, message: "snapshot schema is unsupported" };
  const draft = decodeSnapshotDraft(raw.draft, limits);
  if (!draft) return { ok: false, message: "snapshot draft is invalid" };
  const processedOpIds = raw.processedOpIds;
  if (
    !Array.isArray(processedOpIds) ||
    processedOpIds.length > limits.maxProcessedOpIds ||
    !processedOpIds.every(
      (opId) => isNonEmptyString(opId) && opId.length <= limits.maxIdLength,
    ) ||
    new Set(processedOpIds).size !== processedOpIds.length
  )
    return { ok: false, message: "snapshot processed-op ledger is invalid" };
  const validatedProcessedOpIds = processedOpIds.filter(isNonEmptyString);
  if (
    !Array.isArray(raw.deferred) ||
    raw.deferred.length > limits.maxDeferredSends
  )
    return { ok: false, message: "snapshot deferred queue is invalid" };

  const deferred: DeferredComposerSend[] = [];
  for (const entry of raw.deferred) {
    if (!isRecord(entry))
      return { ok: false, message: "snapshot deferred entry is invalid" };
    const operation = decodeComposerOperation(entry.operation);
    const deferredDraft = decodeSnapshotDraft(entry.draft, limits);
    if (!operation.ok || operation.operation.type !== "send" || !deferredDraft)
      return { ok: false, message: "snapshot deferred send is invalid" };
    deferred.push({ operation: operation.operation, draft: deferredDraft });
  }
  if (
    deferred.some(
      ({ operation }) =>
        operation.opId.length > limits.maxIdLength ||
        validatedProcessedOpIds.includes(operation.opId),
    ) ||
    new Set(deferred.map(({ operation }) => operation.opId)).size !==
      deferred.length
  )
    return { ok: false, message: "snapshot deferred send is invalid" };
  return {
    ok: true,
    snapshot: {
      schema: NATIVE_COMPOSER_SCHEMA,
      draft,
      processedOpIds: validatedProcessedOpIds,
      deferred,
    },
  };
}

/** Best-effort opId for a raw op that failed to decode (for the rejected result). */
function rawOpId(raw: unknown): string {
  if (raw && typeof raw === "object" && "opId" in raw) {
    const id = (raw as { opId: unknown }).opId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "";
}

export function createComposerBridgeClient(
  options: ComposerBridgeClientOptions = {},
): ComposerBridgeClient {
  let state = options.snapshot
    ? hydrate(options.snapshot)
    : initialComposerState();

  const ctx: ComposerApplyContext = {
    online: options.online ?? true,
    capabilities: options.capabilities ?? DEFAULT_COMPOSER_CAPABILITIES,
    limits: options.limits ?? DEFAULT_COMPOSER_LIMITS,
  };

  const listeners = new Set<(event: ComposerEvent) => void>();
  const emit = (event: ComposerEvent): void => {
    for (const listener of listeners) listener(event);
  };

  // A draft-mutating result is echoed to the shell; emit the specific side
  // events (focus/voice) so a shell that only cares about those need not diff.
  const emitFor = (op: ComposerOperation, result: DispatchResult): void => {
    if (result.status !== "applied") return;
    emit({ type: "draft.changed", draft: result.draft });
    if (op.type === "focus.set")
      emit({
        type: "focus.changed",
        focused: result.draft.focused,
        keyboard: result.draft.keyboard,
      });
    if (op.type === "voice.handoff")
      emit({ type: "voice.state", phase: op.phase });
  };

  const applyDecoded = (op: ComposerOperation): DispatchResult => {
    const step = applyComposerOperation(state, op, ctx);
    state = step.state;
    emitFor(op, step.result);
    return step.result;
  };

  return {
    dispatchRaw(raw) {
      const decoded = decodeComposerOperation(raw);
      if (!decoded.ok) {
        return {
          status: "rejected",
          opId: rawOpId(raw),
          reason: "invalid-input",
          message: decoded.error.message,
          draft: state.draft,
        };
      }
      return applyDecoded(decoded.operation);
    },
    dispatchRawStream(raw) {
      let decoded: ReturnType<typeof decodeComposerOperationStream>;
      try {
        decoded = decodeComposerOperationStream(raw);
      } catch (error) {
        // error-policy:J3 untrusted-input sanitizing — an unusable native batch
        // is one explicit invalid result; it must not tear down the composer.
        return [
          {
            status: "rejected",
            opId: "",
            reason: "invalid-input",
            message:
              error instanceof Error
                ? error.message
                : "composer operation stream is invalid",
            draft: state.draft,
          },
        ];
      }
      const { operations, rejected } = decoded;
      const results: DispatchResult[] = [];
      // Preserve source order: rejected ops surface as invalid-input in place.
      let opIdx = 0;
      const rejectedByIndex = new Map(rejected.map((r) => [r.index, r]));
      const total = operations.length + rejected.length;
      for (let i = 0; i < total; i++) {
        const bad = rejectedByIndex.get(i);
        if (bad) {
          results.push({
            status: "rejected",
            opId: "",
            reason: "invalid-input",
            message: bad.error.message,
            draft: state.draft,
          });
        } else {
          results.push(applyDecoded(operations[opIdx++]));
        }
      }
      return results;
    },
    dispatchOperation(op) {
      return applyDecoded(op);
    },
    completeSend(opId, outcome) {
      // Native callbacks may be duplicated or arrive after cancellation. Only
      // the active reservation owns the result event and draft transition.
      if (state.sending?.opId !== opId) return;
      state = resolveSend(state, opId, outcome);
      emit({ type: "send.result", opId, outcome });
      emit({ type: "draft.changed", draft: state.draft });
    },
    setOnline(online) {
      ctx.online = online;
      if (!online) return;
      const flushed = flushDeferredOperations(state, ctx);
      state = flushed.state;
      // A replayed send that applied changes nothing in the draft, but a shell
      // watching the queue wants the draft snapshot after the flush.
      if (flushed.results.some((r) => r.status === "applied"))
        emit({ type: "draft.changed", draft: state.draft });
    },
    getDraft() {
      return state.draft;
    },
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    serialize() {
      const activeSend = state.sending;
      return {
        schema: NATIVE_COMPOSER_SCHEMA,
        draft: state.draft,
        processedOpIds: [...state.processed].filter(
          (opId) => opId !== activeSend?.opId,
        ),
        deferred: activeSend
          ? [
              {
                operation: { type: "send", opId: activeSend.opId },
                draft: activeSend.draft,
              },
              ...state.deferred,
            ]
          : state.deferred,
      };
    },
  };
}

/** Rebuild reducer state from a persisted snapshot (drops the transient send). */
function hydrate(snapshot: ComposerBridgeSnapshot): ComposerBridgeState {
  return {
    draft: snapshot.draft,
    processed: new Set(snapshot.processedOpIds),
    deferred: snapshot.deferred,
    sending: null,
  };
}
