/**
 * Connects `eliza.native-composer/v1` to the real, conversation-scoped chat
 * composer. React state is the authority: native operations mutate that state,
 * manual edits reconcile back into the bridge, and only observed DOM/voice
 * transitions are reported to the native shell. The durable store preserves a
 * separate idempotency ledger and offline queue for every conversation.
 */

import { logger } from "@elizaos/logger";
import type { ChatSendResult } from "@elizaos/shared";
import { useEffect, useRef } from "react";
import type { ChatAttachmentInput, ImageAttachment } from "../api";
import { dispatchChatOpen, dispatchVoiceControl } from "../events";
import {
  acknowledgeNativeComposerOperation,
  type ComposerAttachment,
  type ComposerBridgeClient,
  type ComposerBridgeSnapshot,
  type ComposerDraft,
  type ComposerOperation,
  createComposerBridgeClient,
  decodeComposerBridgeSnapshot,
  decodeComposerOperation,
  dispatchNativeComposerRendererEvent,
  drainNativeComposerOperations,
  NATIVE_COMPOSER_OPERATION_EVENT,
  type NativeComposerOperationDelivery,
} from "../native-composer";
import {
  type FrontendPlatform,
  getFrontendPlatform,
} from "../platform/platform-guards";
import { shellLocalStorage } from "../surface-realm-channel";
import { chatAttachmentClientIdentity } from "../utils/chat-attachment-identity";
import type { ChatReplyTarget } from "./ChatComposerContext.hooks";

const NATIVE_COMPOSER_SNAPSHOT_STORAGE_PREFIX =
  "eliza:native-composer:v1:snapshot";
const NATIVE_COMPOSER_SESSION_STORE_SCHEMA =
  "eliza.native-composer-session-store/v1" as const;
const NEW_CONVERSATION_SCOPE = "__new__";
const MAX_DURABLE_COMPOSER_SESSIONS = 64;

export function nativeComposerSnapshotStorageKey(
  platform: FrontendPlatform = getFrontendPlatform(),
): string {
  return `${NATIVE_COMPOSER_SNAPSHOT_STORAGE_PREFIX}:${platform}`;
}

export type NativeComposerSnapshotReadResult =
  | { status: "empty" }
  | { status: "loaded"; snapshot: ComposerBridgeSnapshot }
  | { status: "invalid"; message: string };

/** Parse the legacy one-session snapshot format at a trust boundary. */
export function decodePersistedNativeComposerSnapshot(
  serialized: string | null,
): NativeComposerSnapshotReadResult {
  if (serialized === null) return { status: "empty" };
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    // error-policy:J3 Corrupt local state is explicit invalid input and never
    // reaches the reducer as a fabricated empty draft.
    return {
      status: "invalid",
      message:
        error instanceof Error
          ? `stored native composer snapshot is not JSON: ${error.message}`
          : "stored native composer snapshot is not JSON",
    };
  }
  const decoded = decodeComposerBridgeSnapshot(raw);
  return decoded.ok
    ? { status: "loaded", snapshot: decoded.snapshot }
    : { status: "invalid", message: decoded.message };
}

export interface NativeComposerUiState {
  activeConversationId: string | null;
  chatInput: string;
  chatPendingImages: ImageAttachment[];
  chatReplyTarget: ChatReplyTarget | null;
}

export interface NativeComposerBridgeOptions extends NativeComposerUiState {
  /** Reads refs updated synchronously by the composer setters. */
  getCurrentComposerState: () => NativeComposerUiState;
  sendChatText: (
    text: string,
    options?: {
      conversationId?: string | null;
      images?: ChatAttachmentInput[];
      metadata?: Record<string, unknown>;
      clientMessageId?: string;
    },
  ) => Promise<ChatSendResult>;
  setChatInput: (text: string) => void;
  setChatPendingImages: (images: ImageAttachment[]) => void;
  setChatReplyTarget: (target: ChatReplyTarget | null) => void;
  interruptActiveChatPipeline: () => void;
  onPersistenceError?: (message: string) => void;
}

interface NativeComposerSession {
  scope: string;
  client: ComposerBridgeClient;
  durableOpIds: Set<string>;
  pendingAcknowledgments: Map<
    NativeComposerOperationDelivery,
    "applied" | "deferred" | "duplicate"
  >;
  activeSends: Set<string>;
  pendingVoiceCommitText: string | null;
  pendingVoiceCommitRequiresBadgeExit: boolean;
  voiceBadgePresent: boolean;
  suppressNextBadgeCancel: boolean;
  /** Active-session effects subscribe directly; background sends use fallback dispatch. */
  hasRendererSubscriber: boolean;
}

interface NativeComposerManager {
  storageKey: string;
  sessions: Map<string, NativeComposerSession>;
  initialPersistenceError: string | null;
}

interface NativeComposerSessionStore {
  schema: typeof NATIVE_COMPOSER_SESSION_STORE_SCHEMA;
  sessions: Record<string, ComposerBridgeSnapshot>;
}

type SessionStoreDecodeResult =
  | { status: "empty" }
  | { status: "loaded"; snapshots: Map<string, ComposerBridgeSnapshot> }
  | { status: "invalid"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conversationScope(conversationId: string | null): string {
  return conversationId ?? NEW_CONVERSATION_SCOPE;
}

function decodeSessionStore(
  serialized: string | null,
  legacyScope: string,
): SessionStoreDecodeResult {
  if (serialized === null) return { status: "empty" };
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    // error-policy:J3 Corrupt durable state is rejected as a unit so an
    // idempotency ledger can never be paired with the wrong draft.
    return {
      status: "invalid",
      message:
        error instanceof Error
          ? `stored native composer sessions are not JSON: ${error.message}`
          : "stored native composer sessions are not JSON",
    };
  }

  if (isRecord(raw) && raw.schema === NATIVE_COMPOSER_SESSION_STORE_SCHEMA) {
    if (!isRecord(raw.sessions))
      return { status: "invalid", message: "stored sessions are invalid" };
    const entries = Object.entries(raw.sessions);
    if (entries.length > MAX_DURABLE_COMPOSER_SESSIONS)
      return { status: "invalid", message: "stored session limit exceeded" };
    const snapshots = new Map<string, ComposerBridgeSnapshot>();
    for (const [scope, candidate] of entries) {
      if (!scope)
        return { status: "invalid", message: "stored session scope is empty" };
      const decoded = decodeComposerBridgeSnapshot(candidate);
      if (!decoded.ok)
        return {
          status: "invalid",
          message: `stored session ${scope} is invalid: ${decoded.message}`,
        };
      snapshots.set(scope, decoded.snapshot);
    }
    return { status: "loaded", snapshots };
  }

  // One release wrote a single platform-wide snapshot. Import it into only the
  // conversation that was active during upgrade; all new writes use the store.
  const legacy = decodeComposerBridgeSnapshot(raw);
  return legacy.ok
    ? {
        status: "loaded",
        snapshots: new Map([[legacyScope, legacy.snapshot]]),
      }
    : { status: "invalid", message: legacy.message };
}

function durableOpIds(snapshot: ComposerBridgeSnapshot): Set<string> {
  return new Set([
    ...snapshot.processedOpIds,
    ...snapshot.deferred.map(({ operation }) => operation.opId),
  ]);
}

function createSession(
  scope: string,
  snapshot?: ComposerBridgeSnapshot,
): NativeComposerSession {
  return {
    scope,
    client: createComposerBridgeClient({
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(snapshot ? { snapshot } : {}),
    }),
    durableOpIds: snapshot ? durableOpIds(snapshot) : new Set(),
    pendingAcknowledgments: new Map(),
    activeSends: new Set(),
    pendingVoiceCommitText: null,
    pendingVoiceCommitRequiresBadgeExit: false,
    voiceBadgePresent: false,
    suppressNextBadgeCancel: false,
    hasRendererSubscriber: false,
  };
}

function initializeManager(initialScope: string): NativeComposerManager {
  const storageKey = nativeComposerSnapshotStorageKey();
  const manager: NativeComposerManager = {
    storageKey,
    sessions: new Map(),
    initialPersistenceError: null,
  };
  if (typeof window === "undefined") return manager;

  try {
    const decoded = decodeSessionStore(
      window.localStorage.getItem(storageKey),
      initialScope,
    );
    if (decoded.status === "loaded") {
      for (const [scope, snapshot] of decoded.snapshots) {
        manager.sessions.set(scope, createSession(scope, snapshot));
      }
    } else if (decoded.status === "invalid") {
      manager.initialPersistenceError = decoded.message;
      logger.error(
        { storageKey, message: decoded.message },
        "[NativeComposer] Ignoring invalid persisted session store",
      );
      try {
        shellLocalStorage.removeItem(storageKey);
      } catch (error) {
        // error-policy:J6 Removing corrupt local state is best-effort; the
        // strict decoder has already isolated it from live reducer state.
        logger.warn(
          { error, storageKey },
          "[NativeComposer] Could not remove invalid session store",
        );
      }
    }
  } catch (error) {
    // error-policy:J4 A blocked storage read leaves the live bridge usable and
    // surfaces the loss of reload/offline recovery to the user.
    manager.initialPersistenceError =
      "Native composer recovery is unavailable.";
    logger.error(
      { error, storageKey },
      "[NativeComposer] Could not read persisted session store",
    );
  }
  return manager;
}

function migrateSession(
  manager: NativeComposerManager,
  session: NativeComposerSession,
  nextScope: string,
): void {
  if (session.scope === nextScope) return;
  const existing = manager.sessions.get(nextScope);
  if (existing && existing !== session) return;
  manager.sessions.delete(session.scope);
  session.scope = nextScope;
  manager.sessions.set(nextScope, session);
}

function getSession(
  manager: NativeComposerManager,
  scope: string,
): NativeComposerSession {
  const existing = manager.sessions.get(scope);
  if (existing) return existing;
  if (scope !== NEW_CONVERSATION_SCOPE) {
    const unsaved = manager.sessions.get(NEW_CONVERSATION_SCOPE);
    if (unsaved?.client.getState().sending) {
      migrateSession(manager, unsaved, scope);
      return unsaved;
    }
  }
  const session = createSession(scope);
  manager.sessions.set(scope, session);
  return session;
}

function pruneSessions(
  manager: NativeComposerManager,
  activeScope: string,
): void {
  while (manager.sessions.size > MAX_DURABLE_COMPOSER_SESSIONS) {
    const removable = [...manager.sessions].find(
      ([scope, session]) =>
        scope !== activeScope &&
        session.activeSends.size === 0 &&
        !session.client.getState().sending,
    );
    if (!removable) return;
    manager.sessions.delete(removable[0]);
  }
}

function acknowledgePersistedDeliveries(manager: NativeComposerManager): void {
  for (const session of manager.sessions.values()) {
    for (const [delivery, resultStatus] of session.pendingAcknowledgments) {
      acknowledgeNativeComposerOperation(delivery, {
        disposition: "persisted",
        resultStatus,
      });
    }
    session.pendingAcknowledgments.clear();
  }
}

function persistManager(
  manager: NativeComposerManager,
  options: NativeComposerBridgeOptions,
  activeScope: string,
): boolean {
  if (typeof window === "undefined") return false;
  pruneSessions(manager, activeScope);
  const store: NativeComposerSessionStore = {
    schema: NATIVE_COMPOSER_SESSION_STORE_SCHEMA,
    sessions: {},
  };
  for (const [scope, session] of manager.sessions) {
    store.sessions[scope] = session.client.serialize();
  }
  try {
    shellLocalStorage.setItem(manager.storageKey, JSON.stringify(store));
    for (const [scope, session] of manager.sessions) {
      const snapshot = store.sessions[scope];
      if (snapshot) session.durableOpIds = durableOpIds(snapshot);
    }
    acknowledgePersistedDeliveries(manager);
    return true;
  } catch (error) {
    // error-policy:J4 The composer remains live in memory when storage is
    // blocked, while the user is told reload recovery could not be saved.
    logger.error(
      { error, storageKey: manager.storageKey },
      "[NativeComposer] Could not persist composer sessions",
    );
    options.onPersistenceError?.(
      "Native composer recovery could not be saved on this device.",
    );
    return false;
  }
}

function stableAttachmentId(
  image: ImageAttachment,
  occurrence: number,
): string {
  if (image.clientAttachmentId) return image.clientAttachmentId;
  return `${chatAttachmentClientIdentity(image)}-${occurrence}`;
}

function ensureImageIdentities(images: ImageAttachment[]): ImageAttachment[] {
  return images.map((image, index) => ({
    ...image,
    clientAttachmentId: stableAttachmentId(image, index),
  }));
}

function imageToAttachment(
  image: ImageAttachment,
  index: number,
): ComposerAttachment {
  const id = stableAttachmentId(image, index);
  const mimeType = image.mimeType.toLowerCase();
  return {
    id,
    url: `data:${mimeType};base64,${image.data}`,
    mimeType,
    name: image.name,
    kind: "inline",
    status: "ready",
  };
}

function composerDraftFromUi(
  ui: NativeComposerUiState,
  current: ComposerDraft,
): Omit<ComposerDraft, "revision"> {
  return {
    text: ui.chatInput,
    attachments: ui.chatPendingImages.map(imageToAttachment),
    reply: ui.chatReplyTarget
      ? {
          messageId: ui.chatReplyTarget.messageId,
          authorId: ui.chatReplyTarget.senderName,
          preview: ui.chatReplyTarget.snippet,
        }
      : null,
    mentions: [],
    focused: current.focused,
    keyboard: current.keyboard,
  };
}

function inlineAttachmentToImage(
  attachment: ComposerAttachment,
  existing: ImageAttachment | undefined,
): ImageAttachment | null {
  if (attachment.kind !== "inline" || !attachment.url.startsWith("data:"))
    return null;
  const comma = attachment.url.indexOf(",");
  if (comma < 0) return null;
  const header = attachment.url.slice(5, comma);
  if (!/(?:^|;)base64(?:;|$)/i.test(header)) return null;
  const mimeType = attachment.mimeType ?? header.split(";", 1)[0] ?? "";
  if (!mimeType) return null;
  const data = attachment.url.slice(comma + 1);
  const thumbnail =
    existing?.data === data && existing.mimeType === mimeType
      ? existing.thumbnail
      : undefined;
  return {
    data,
    mimeType,
    name: attachment.name ?? `attachment-${attachment.id}`,
    clientAttachmentId: attachment.id,
    ...(thumbnail ? { thumbnail } : {}),
  };
}

function sameImages(
  left: ImageAttachment[],
  right: ImageAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((image, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        image.clientAttachmentId === other.clientAttachmentId &&
        image.data === other.data &&
        image.mimeType === other.mimeType &&
        image.name === other.name &&
        image.thumbnail?.data === other.thumbnail?.data &&
        image.thumbnail?.mimeType === other.thumbnail?.mimeType
      );
    })
  );
}

function sameReply(
  left: ChatReplyTarget | null,
  right: ChatReplyTarget | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.messageId === right.messageId &&
      left.senderName === right.senderName &&
      left.snippet === right.snippet)
  );
}

function mirrorDraftToUi(
  draft: ComposerDraft,
  options: NativeComposerBridgeOptions,
): void {
  const live = options.getCurrentComposerState();
  if (live.chatInput !== draft.text) options.setChatInput(draft.text);
  const existingById = new Map(
    live.chatPendingImages.map((image, index) => [
      stableAttachmentId(image, index),
      image,
    ]),
  );
  const images = draft.attachments
    .map((attachment) =>
      inlineAttachmentToImage(attachment, existingById.get(attachment.id)),
    )
    .filter((image): image is ImageAttachment => image !== null);
  if (!sameImages(live.chatPendingImages, images))
    options.setChatPendingImages(images);
  const reply = draft.reply
    ? {
        messageId: draft.reply.messageId,
        senderName: draft.reply.authorId ?? "Message",
        snippet: draft.reply.preview ?? "",
      }
    : null;
  if (!sameReply(live.chatReplyTarget, reply))
    options.setChatReplyTarget(reply);
}

function attachmentToChatInput(
  attachment: ComposerAttachment,
): ChatAttachmentInput {
  if (attachment.kind === "remote") {
    return {
      source: "remote",
      url: attachment.url,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.name ? { name: attachment.name } : {}),
    };
  }
  if (attachment.kind === "stored") {
    return {
      source: "stored",
      url: attachment.url,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.name ? { name: attachment.name } : {}),
    };
  }
  return {
    source: "data-url",
    dataUrl: attachment.url,
    ...(attachment.name ? { name: attachment.name } : {}),
  };
}

function failedSendResult(
  session: NativeComposerSession,
  operationId: string,
  error: unknown,
): ChatSendResult {
  return {
    status: "failed",
    conversationId:
      session.scope === NEW_CONVERSATION_SCOPE ? null : session.scope,
    clientMessageId: operationId,
    reason: "transport",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function cancelledSendResult(
  session: NativeComposerSession,
  operationId: string,
): ChatSendResult {
  return {
    status: "cancelled",
    conversationId:
      session.scope === NEW_CONVERSATION_SCOPE ? null : session.scope,
    clientMessageId: operationId,
    message: "Send cancelled by the native composer.",
  };
}

function validateNativeSendOutcome(
  session: NativeComposerSession,
  operationId: string,
  outcome: ChatSendResult,
): ChatSendResult {
  if (outcome.status !== "accepted") return outcome;
  if (outcome.receipt.clientMessageId === operationId) return outcome;
  return {
    status: "failed",
    conversationId:
      session.scope === NEW_CONVERSATION_SCOPE ? null : session.scope,
    clientMessageId: operationId,
    reason: "missing-receipt",
    message: "The chat boundary returned a receipt for a different send.",
    retryable: true,
  };
}

function reconcileLatestUi(
  session: NativeComposerSession,
  options: NativeComposerBridgeOptions,
  acceptedConversationId?: string,
): void {
  const live = options.getCurrentComposerState();
  const liveScope = conversationScope(live.activeConversationId);
  if (
    liveScope !== session.scope &&
    live.activeConversationId !== acceptedConversationId
  )
    return;
  session.client.reconcileDraft(
    composerDraftFromUi(live, session.client.getDraft()),
  );
}

async function sendNativeDraft(
  manager: NativeComposerManager,
  session: NativeComposerSession,
  operation: Extract<ComposerOperation, { type: "send" }>,
  optionsRef: { current: NativeComposerBridgeOptions },
): Promise<void> {
  const active = session.client.getState().sending;
  if (!active || active.opId !== operation.opId) return;
  let outcome: ChatSendResult;
  try {
    outcome = await optionsRef.current.sendChatText(active.draft.text, {
      conversationId:
        session.scope === NEW_CONVERSATION_SCOPE ? null : session.scope,
      images: active.draft.attachments.map(attachmentToChatInput),
      metadata: {
        nativeComposer: true,
        nativeComposerOpId: operation.opId,
        ...(active.draft.reply
          ? { replyToMessageId: active.draft.reply.messageId }
          : {}),
      },
      clientMessageId: operation.opId,
    });
  } catch (error) {
    // error-policy:J1 The chat-send boundary normally returns a typed failure;
    // an unexpected throw is translated once for the native transport.
    outcome = failedSendResult(session, operation.opId, error);
  }
  outcome = validateNativeSendOutcome(session, operation.opId, outcome);

  // Cancellation owns the terminal result. A transport that races the abort
  // may still resolve, but it must not migrate, clear, or emit a second result.
  if (session.client.getState().sending?.opId !== operation.opId) return;

  if (
    outcome.status === "accepted" &&
    session.scope === NEW_CONVERSATION_SCOPE
  ) {
    migrateSession(
      manager,
      session,
      conversationScope(outcome.receipt.conversationId),
    );
  }
  reconcileLatestUi(
    session,
    optionsRef.current,
    outcome.status === "accepted" ? outcome.receipt.conversationId : undefined,
  );
  const previousDraft = session.client.getDraft();
  const hasRendererSubscriber = session.hasRendererSubscriber;
  session.client.completeSend(operation.opId, outcome);
  if (!hasRendererSubscriber) {
    dispatchNativeComposerRendererEvent({
      type: "send.result",
      opId: operation.opId,
      outcome,
    });
    const nextDraft = session.client.getDraft();
    if (previousDraft.revision !== nextDraft.revision) {
      dispatchNativeComposerRendererEvent({
        type: "draft.changed",
        draft: nextDraft,
      });
    }
  }
  const live = optionsRef.current.getCurrentComposerState();
  if (
    conversationScope(live.activeConversationId) === session.scope ||
    (outcome.status === "accepted" &&
      live.activeConversationId === outcome.receipt.conversationId)
  )
    mirrorDraftToUi(session.client.getDraft(), optionsRef.current);
  persistManager(manager, optionsRef.current, session.scope);
}

function observedKeyboardState(focused: boolean): ComposerDraft["keyboard"] {
  if (!focused) return "hidden";
  const viewport = window.visualViewport;
  return viewport && viewport.height < window.innerHeight - 80
    ? "shown"
    : "hidden";
}

function composerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(
    '[data-testid="chat-composer-textarea"]',
  );
}

function observePendingVoiceCommit(
  session: NativeComposerSession,
  ui: NativeComposerUiState,
  badgeExitObserved = false,
): void {
  const target = session.pendingVoiceCommitText;
  if (target === null) return;
  if (
    conversationScope(ui.activeConversationId) !== session.scope ||
    ui.chatInput !== target
  )
    return;
  if (session.pendingVoiceCommitRequiresBadgeExit && !badgeExitObserved) return;
  session.pendingVoiceCommitText = null;
  session.pendingVoiceCommitRequiresBadgeExit = false;
  session.suppressNextBadgeCancel = session.voiceBadgePresent;
  session.client.observeVoice("commit");
}

/** Install the renderer consumer and reconcile both directions continuously. */
export function useNativeComposerBridge(
  options: NativeComposerBridgeOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const scope = conversationScope(options.activeConversationId);
  const managerRef = useRef<NativeComposerManager | null>(null);
  if (!managerRef.current) managerRef.current = initializeManager(scope);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const session = getSession(manager, scope);
    if (manager.initialPersistenceError) {
      optionsRef.current.onPersistenceError?.(
        `Native composer recovery was reset: ${manager.initialPersistenceError}`,
      );
      manager.initialPersistenceError = null;
    }

    const persist = (): boolean =>
      persistManager(manager, optionsRef.current, session.scope);
    const unsubscribe = session.client.subscribe((event) => {
      dispatchNativeComposerRendererEvent(event);
      persist();
    });
    session.hasRendererSubscriber = true;

    const initialUi = optionsRef.current.getCurrentComposerState();
    const identifiedImages = ensureImageIdentities(initialUi.chatPendingImages);
    if (!sameImages(initialUi.chatPendingImages, identifiedImages))
      optionsRef.current.setChatPendingImages(identifiedImages);
    const initialRevision = session.client.getDraft().revision;
    session.client.reconcileDraft(
      composerDraftFromUi(
        { ...initialUi, chatPendingImages: identifiedImages },
        session.client.getDraft(),
      ),
    );
    if (session.client.getDraft().revision === initialRevision) {
      dispatchNativeComposerRendererEvent({
        type: "draft.changed",
        draft: session.client.getDraft(),
      });
    }

    const driveSend = (
      operation: Extract<ComposerOperation, { type: "send" }>,
    ): void => {
      if (session.activeSends.has(operation.opId)) return;
      session.activeSends.add(operation.opId);
      void sendNativeDraft(manager, session, operation, optionsRef).finally(
        () => {
          session.activeSends.delete(operation.opId);
        },
      );
    };

    let focusRequestTimer: number | null = null;
    const requestFocus = (focused: boolean): void => {
      if (focused) dispatchChatOpen();
      if (focusRequestTimer !== null) window.clearTimeout(focusRequestTimer);
      focusRequestTimer = window.setTimeout(() => {
        focusRequestTimer = null;
        const textarea = composerTextarea();
        if (focused) textarea?.focus();
        else textarea?.blur();
        const observed = document.activeElement === textarea;
        session.client.observeFocus(observed, observedKeyboardState(observed));
      }, 0);
    };

    const consume = (delivery: NativeComposerOperationDelivery): void => {
      const decoded = decodeComposerOperation(delivery.operation);
      if (!decoded.ok) {
        session.client.dispatchRaw(delivery.operation);
        acknowledgeNativeComposerOperation(delivery, {
          disposition: "rejected",
          resultStatus: "invalid-input",
          reason: decoded.error.message,
        });
        return;
      }

      const operation = decoded.operation;
      const deferredSendBeingCancelled =
        operation.type === "cancel" && operation.scope === "send"
          ? session.client.getState().deferred[0]
          : undefined;
      const sendBeingCancelled =
        operation.type === "cancel" && operation.scope === "send"
          ? session.client.getState().sending
          : null;
      if (sendBeingCancelled) {
        optionsRef.current.interruptActiveChatPipeline();
        session.client.completeSend(
          sendBeingCancelled.opId,
          cancelledSendResult(session, sendBeingCancelled.opId),
        );
      }
      const result = session.client.dispatchOperation(operation);
      if (result.status === "rejected") {
        acknowledgeNativeComposerOperation(delivery, {
          disposition: "rejected",
          resultStatus: result.status,
          reason: result.reason,
        });
      } else if (session.durableOpIds.has(operation.opId)) {
        acknowledgeNativeComposerOperation(delivery, {
          disposition: "persisted",
          resultStatus: result.status,
        });
      } else {
        session.pendingAcknowledgments.set(delivery, result.status);
        persist();
      }

      if (result.status !== "applied") return;
      if (deferredSendBeingCancelled) {
        // Offline sends have no active transport promise to resolve. The cancel
        // reducer removes the durable queue entry; publish the corresponding
        // typed terminal result here so the shell does not wait forever.
        dispatchNativeComposerRendererEvent({
          type: "send.result",
          opId: deferredSendBeingCancelled.operation.opId,
          outcome: cancelledSendResult(
            session,
            deferredSendBeingCancelled.operation.opId,
          ),
        });
      }
      if (operation.type === "focus.set") requestFocus(operation.focused);
      if (operation.type === "voice.handoff") {
        if (operation.phase === "start")
          dispatchVoiceControl({ command: "start" });
        else dispatchVoiceControl({ command: "stop" });
        if (operation.phase === "commit") {
          session.pendingVoiceCommitText = result.draft.text;
          session.pendingVoiceCommitRequiresBadgeExit =
            optionsRef.current.chatInput === result.draft.text;
        }
      }
      if (operation.type !== "focus.set" && operation.type !== "send")
        mirrorDraftToUi(result.draft, optionsRef.current);
      if (operation.type === "voice.handoff")
        observePendingVoiceCommit(session, optionsRef.current);
      if (operation.type === "send") driveSend(operation);
    };

    const onOperation = (event: Event): void => {
      consume((event as CustomEvent<NativeComposerOperationDelivery>).detail);
    };
    window.addEventListener(NATIVE_COMPOSER_OPERATION_EVENT, onOperation);
    for (const delivery of drainNativeComposerOperations()) consume(delivery);

    const onOnline = (): void => {
      session.client.setOnline(true);
      persist();
      const active = session.client.getState().sending;
      if (active) driveSend({ type: "send", opId: active.opId });
    };
    const onOffline = (): void => {
      session.client.setOnline(false);
      persist();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    session.client.setOnline(navigator.onLine);

    const observeFocus = (): void => {
      const textarea = composerTextarea();
      const focused = document.activeElement === textarea;
      session.client.observeFocus(focused, observedKeyboardState(focused));
    };
    document.addEventListener("focusin", observeFocus);
    document.addEventListener("focusout", observeFocus);
    window.visualViewport?.addEventListener("resize", observeFocus);
    observeFocus();

    const observeVoiceBadge = (): void => {
      if (typeof document === "undefined") return;
      const present = Boolean(
        document.querySelector('[data-testid="chat-transcribing-badge"]'),
      );
      if (present === session.voiceBadgePresent) return;
      session.voiceBadgePresent = present;
      if (present) {
        session.client.observeVoice("start");
      } else if (session.suppressNextBadgeCancel) {
        session.suppressNextBadgeCancel = false;
      } else if (session.pendingVoiceCommitText !== null) {
        observePendingVoiceCommit(session, optionsRef.current, true);
      } else {
        session.client.observeVoice("cancel");
      }
    };
    const voiceObserver = new MutationObserver(observeVoiceBadge);
    voiceObserver.observe(document.body, { childList: true, subtree: true });
    observeVoiceBadge();

    persist();
    const active = session.client.getState().sending;
    if (active) driveSend({ type: "send", opId: active.opId });

    return () => {
      unsubscribe();
      session.hasRendererSubscriber = false;
      if (focusRequestTimer !== null) window.clearTimeout(focusRequestTimer);
      window.removeEventListener(NATIVE_COMPOSER_OPERATION_EVENT, onOperation);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("focusin", observeFocus);
      document.removeEventListener("focusout", observeFocus);
      window.visualViewport?.removeEventListener("resize", observeFocus);
      voiceObserver.disconnect();
    };
  }, [scope]);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const session = getSession(manager, scope);
    const currentOptions = optionsRef.current;
    const ui: NativeComposerUiState = {
      activeConversationId: options.activeConversationId,
      chatInput: options.chatInput,
      chatPendingImages: options.chatPendingImages,
      chatReplyTarget: options.chatReplyTarget,
    };
    const identifiedImages = ensureImageIdentities(ui.chatPendingImages);
    if (!sameImages(ui.chatPendingImages, identifiedImages))
      currentOptions.setChatPendingImages(identifiedImages);
    session.client.reconcileDraft(
      composerDraftFromUi(
        { ...ui, chatPendingImages: identifiedImages },
        session.client.getDraft(),
      ),
    );
    observePendingVoiceCommit(session, ui);
    persistManager(manager, currentOptions, session.scope);
  }, [
    options.activeConversationId,
    options.chatInput,
    options.chatPendingImages,
    options.chatReplyTarget,
    scope,
  ]);
}
