/**
 * Connects `eliza.native-composer/v1` to the real chat composer and send
 * chokepoint. Native draft mutations update the shared React composer; native
 * sends enter `sendChatText`, whose authenticated server boundary materializes
 * attachments into the single content-addressed media store.
 */

import { logger } from "@elizaos/logger";
import { useEffect, useRef } from "react";
import type { ChatAttachmentInput, ImageAttachment } from "../api";
import { dispatchChatOpen } from "../events";
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
import type { ChatReplyTarget } from "./ChatComposerContext.hooks";

const NATIVE_COMPOSER_SNAPSHOT_STORAGE_PREFIX =
  "eliza:native-composer:v1:snapshot";

export function nativeComposerSnapshotStorageKey(
  platform: FrontendPlatform = getFrontendPlatform(),
): string {
  return `${NATIVE_COMPOSER_SNAPSHOT_STORAGE_PREFIX}:${platform}`;
}

export type NativeComposerSnapshotReadResult =
  | { status: "empty" }
  | { status: "loaded"; snapshot: ComposerBridgeSnapshot }
  | { status: "invalid"; message: string };

/** Parse and validate a persisted snapshot before the reducer trusts it. */
export function decodePersistedNativeComposerSnapshot(
  serialized: string | null,
): NativeComposerSnapshotReadResult {
  if (serialized === null) return { status: "empty" };
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    // error-policy:J3 A corrupt local-storage value is explicit invalid input;
    // it is removed by the storage boundary instead of becoming reducer state.
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

export interface NativeComposerBridgeOptions {
  sendChatText: (
    text: string,
    options?: {
      images?: ChatAttachmentInput[];
      metadata?: Record<string, unknown>;
      clientMessageId?: string;
    },
  ) => Promise<void>;
  setChatInput: (text: string) => void;
  setChatPendingImages: (images: ImageAttachment[]) => void;
  setChatReplyTarget: (target: ChatReplyTarget | null) => void;
  interruptActiveChatPipeline: () => void;
  onPersistenceError?: (message: string) => void;
}

interface NativeComposerSession {
  client: ComposerBridgeClient;
  storageKey: string;
  initialPersistenceError: string | null;
  durableOpIds: Set<string>;
}

function initializeSession(): NativeComposerSession {
  const storageKey = nativeComposerSnapshotStorageKey();
  let snapshot: ComposerBridgeSnapshot | undefined;
  let initialPersistenceError: string | null = null;
  if (typeof window !== "undefined") {
    try {
      const decoded = decodePersistedNativeComposerSnapshot(
        window.localStorage.getItem(storageKey),
      );
      if (decoded.status === "loaded") {
        snapshot = decoded.snapshot;
      } else if (decoded.status === "invalid") {
        initialPersistenceError = decoded.message;
        logger.error(
          { storageKey, message: decoded.message },
          "[NativeComposer] Ignoring invalid persisted snapshot",
        );
        try {
          shellLocalStorage.removeItem(storageKey);
        } catch (error) {
          // error-policy:J6 Removing corrupt local state is best-effort; the
          // strict decoder still prevents it from reaching the reducer.
          logger.warn(
            { error, storageKey },
            "[NativeComposer] Could not remove invalid persisted snapshot",
          );
        }
      }
    } catch (error) {
      // error-policy:J4 A blocked storage read degrades to a fresh composer and
      // is surfaced to the user; live native operations remain usable.
      initialPersistenceError = "Native composer recovery is unavailable.";
      logger.error(
        { error, storageKey },
        "[NativeComposer] Could not read persisted snapshot",
      );
    }
  }
  return {
    storageKey,
    initialPersistenceError,
    durableOpIds: new Set([
      ...(snapshot?.processedOpIds ?? []),
      ...(snapshot?.deferred.map(({ operation }) => operation.opId) ?? []),
    ]),
    client: createComposerBridgeClient({
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(snapshot ? { snapshot } : {}),
    }),
  };
}

function persistSession(
  session: NativeComposerSession,
  options: NativeComposerBridgeOptions,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const snapshot = session.client.serialize();
    shellLocalStorage.setItem(session.storageKey, JSON.stringify(snapshot));
    session.durableOpIds = new Set([
      ...snapshot.processedOpIds,
      ...snapshot.deferred.map(({ operation }) => operation.opId),
    ]);
    return true;
  } catch (error) {
    // error-policy:J4 The composer stays live in memory when platform storage
    // is blocked, but the user is told reload/offline recovery is unavailable.
    logger.error(
      { error, storageKey: session.storageKey },
      "[NativeComposer] Could not persist composer state",
    );
    options.onPersistenceError?.(
      "Native composer recovery could not be saved on this device.",
    );
    return false;
  }
}

function inlineAttachmentToImage(
  attachment: ComposerAttachment,
): ImageAttachment | null {
  if (attachment.kind !== "inline" || !attachment.url.startsWith("data:")) {
    return null;
  }
  const comma = attachment.url.indexOf(",");
  if (comma < 0) return null;
  const header = attachment.url.slice(5, comma);
  if (!/(?:^|;)base64(?:;|$)/i.test(header)) return null;
  const mimeType = attachment.mimeType ?? header.split(";", 1)[0] ?? "";
  if (!mimeType) return null;
  return {
    data: attachment.url.slice(comma + 1),
    mimeType,
    name: attachment.name ?? `attachment-${attachment.id}`,
  };
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

function mirrorDraft(
  draft: ComposerDraft,
  operation: ComposerOperation,
  options: NativeComposerBridgeOptions,
): void {
  switch (operation.type) {
    case "text.insert":
    case "text.set":
    case "mention.add":
    case "voice.handoff":
      options.setChatInput(draft.text);
      break;
    case "attachment.add":
    case "attachment.remove":
      options.setChatPendingImages(
        draft.attachments
          .map(inlineAttachmentToImage)
          .filter((image): image is ImageAttachment => image !== null),
      );
      break;
    case "reply.set":
      options.setChatReplyTarget({
        messageId: draft.reply?.messageId ?? operation.reply.messageId,
        senderName: draft.reply?.authorId ?? "Message",
        snippet: draft.reply?.preview ?? "",
      });
      break;
    case "reply.clear":
      options.setChatReplyTarget(null);
      break;
    case "focus.set":
      if (operation.focused) dispatchChatOpen();
      break;
    case "cancel":
      if (operation.scope === "draft") {
        options.setChatInput(draft.text);
        options.setChatPendingImages([]);
        options.setChatReplyTarget(null);
      } else {
        options.interruptActiveChatPipeline();
      }
      break;
    case "send":
      break;
  }
}

function mirrorHydratedDraft(
  draft: ComposerDraft,
  options: NativeComposerBridgeOptions,
): void {
  // Empty bridge fields must not erase the active conversation's independently
  // persisted draft. Native mutations already mirrored clears before reload;
  // hydration only has work when the native snapshot owns actual content.
  if (draft.text.length > 0) options.setChatInput(draft.text);
  if (draft.attachments.length > 0) {
    options.setChatPendingImages(
      draft.attachments
        .map(inlineAttachmentToImage)
        .filter((image): image is ImageAttachment => image !== null),
    );
  }
  if (draft.reply) {
    options.setChatReplyTarget({
      messageId: draft.reply.messageId,
      senderName: draft.reply.authorId ?? "Message",
      snippet: draft.reply.preview ?? "",
    });
  }
  if (draft.focused) dispatchChatOpen();
}

async function sendNativeDraft(
  client: ComposerBridgeClient,
  operation: Extract<ComposerOperation, { type: "send" }>,
  options: NativeComposerBridgeOptions,
): Promise<void> {
  const active = client.getState().sending;
  if (!active || active.opId !== operation.opId) return;
  try {
    await options.sendChatText(active.draft.text, {
      images: active.draft.attachments.map(attachmentToChatInput),
      metadata: {
        nativeComposer: true,
        nativeComposerOpId: operation.opId,
      },
      clientMessageId: operation.opId,
    });
    client.completeSend(operation.opId, {
      ok: true,
      messageId: operation.opId,
    });
    options.setChatInput("");
    options.setChatPendingImages([]);
    options.setChatReplyTarget(null);
  } catch (error) {
    // error-policy:J1 The chat-send action boundary translates transport and
    // materialization failures into the typed native send result.
    client.completeSend(operation.opId, {
      ok: false,
      reason: "send-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Install the one renderer consumer for native composer operations. */
export function useNativeComposerBridge(
  options: NativeComposerBridgeOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<NativeComposerSession | null>(null);
  if (!sessionRef.current) sessionRef.current = initializeSession();

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    const { client } = session;
    if (session.initialPersistenceError) {
      optionsRef.current.onPersistenceError?.(
        `Native composer recovery was reset: ${session.initialPersistenceError}`,
      );
      session.initialPersistenceError = null;
    }
    mirrorHydratedDraft(client.getDraft(), optionsRef.current);
    const pendingDurableAcknowledgments = new Map<
      NativeComposerOperationDelivery,
      "applied" | "deferred" | "duplicate"
    >();
    const acknowledgePersistedDeliveries = (): void => {
      for (const [delivery, resultStatus] of pendingDurableAcknowledgments) {
        acknowledgeNativeComposerOperation(delivery, {
          disposition: "persisted",
          resultStatus,
        });
      }
      pendingDurableAcknowledgments.clear();
    };
    const persistAndAcknowledge = (): boolean => {
      const persisted = persistSession(session, optionsRef.current);
      if (persisted) acknowledgePersistedDeliveries();
      return persisted;
    };
    const unsubscribe = client.subscribe((event) => {
      dispatchNativeComposerRendererEvent(event);
      persistAndAcknowledge();
    });
    const activeSends = new Set<string>();

    const driveSend = (
      operation: Extract<ComposerOperation, { type: "send" }>,
    ): void => {
      if (activeSends.has(operation.opId)) return;
      activeSends.add(operation.opId);
      void sendNativeDraft(client, operation, optionsRef.current).finally(
        () => {
          activeSends.delete(operation.opId);
        },
      );
    };

    const consume = (delivery: NativeComposerOperationDelivery): void => {
      const decoded = decodeComposerOperation(delivery.operation);
      if (!decoded.ok) {
        client.dispatchRaw(delivery.operation);
        acknowledgeNativeComposerOperation(delivery, {
          disposition: "rejected",
          resultStatus: "invalid-input",
          reason: decoded.error.message,
        });
        return;
      }
      const result = client.dispatchOperation(decoded.operation);
      if (result.status === "rejected") {
        acknowledgeNativeComposerOperation(delivery, {
          disposition: "rejected",
          resultStatus: result.status,
          reason: result.reason,
        });
      } else if (session.durableOpIds.has(decoded.operation.opId)) {
        acknowledgeNativeComposerOperation(delivery, {
          disposition: "persisted",
          resultStatus: result.status,
        });
      } else {
        pendingDurableAcknowledgments.set(delivery, result.status);
        persistAndAcknowledge();
      }
      if (result.status === "applied") {
        mirrorDraft(result.draft, decoded.operation, optionsRef.current);
        if (decoded.operation.type === "send") {
          driveSend(decoded.operation);
        }
      }
    };

    const onOperation = (event: Event): void => {
      consume((event as CustomEvent<NativeComposerOperationDelivery>).detail);
    };
    window.addEventListener(NATIVE_COMPOSER_OPERATION_EVENT, onOperation);
    for (const raw of drainNativeComposerOperations()) consume(raw);
    const onOnline = (): void => {
      client.setOnline(true);
      persistAndAcknowledge();
      const active = client.getState().sending;
      if (active) driveSend({ type: "send", opId: active.opId });
    };
    const onOffline = (): void => {
      client.setOnline(false);
      persistAndAcknowledge();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    client.setOnline(navigator.onLine);
    persistAndAcknowledge();
    const active = client.getState().sending;
    if (active) driveSend({ type: "send", opId: active.opId });
    return () => {
      unsubscribe();
      window.removeEventListener(NATIVE_COMPOSER_OPERATION_EVENT, onOperation);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
}
