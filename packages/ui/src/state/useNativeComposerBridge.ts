/**
 * Connects `eliza.native-composer/v1` to the real chat composer and send
 * chokepoint. Native draft mutations update the shared React composer; native
 * sends enter `sendChatText`, whose authenticated server boundary materializes
 * attachments into the single content-addressed media store.
 */

import { useEffect, useRef } from "react";
import type { ChatAttachmentInput, ImageAttachment } from "../api";
import { dispatchChatOpen } from "../events";
import {
  acknowledgeNativeComposerOperation,
  type ComposerAttachment,
  type ComposerBridgeClient,
  type ComposerDraft,
  type ComposerOperation,
  createComposerBridgeClient,
  decodeComposerOperation,
  dispatchNativeComposerRendererEvent,
  drainNativeComposerOperations,
  NATIVE_COMPOSER_OPERATION_EVENT,
} from "../native-composer";
import type { ChatReplyTarget } from "./ChatComposerContext.hooks";

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
      reason: "unsupported",
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
  const clientRef = useRef<ComposerBridgeClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = createComposerBridgeClient({
      online: typeof navigator === "undefined" ? true : navigator.onLine,
    });
  }

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    const unsubscribe = client.subscribe(dispatchNativeComposerRendererEvent);
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

    const consume = (raw: unknown): void => {
      const decoded = decodeComposerOperation(raw);
      if (!decoded.ok) {
        client.dispatchRaw(raw);
        return;
      }
      const result = client.dispatchOperation(decoded.operation);
      if (result.status !== "applied") return;
      mirrorDraft(result.draft, decoded.operation, optionsRef.current);
      if (decoded.operation.type === "send") {
        driveSend(decoded.operation);
      }
    };

    const onOperation = (event: Event): void => {
      const raw = (event as CustomEvent<unknown>).detail;
      acknowledgeNativeComposerOperation(raw);
      consume(raw);
    };
    window.addEventListener(NATIVE_COMPOSER_OPERATION_EVENT, onOperation);
    for (const raw of drainNativeComposerOperations()) consume(raw);
    const onOnline = (): void => {
      client.setOnline(true);
      const active = client.getState().sending;
      if (active) driveSend({ type: "send", opId: active.opId });
    };
    const onOffline = (): void => client.setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    client.setOnline(navigator.onLine);
    return () => {
      unsubscribe();
      window.removeEventListener(NATIVE_COMPOSER_OPERATION_EVENT, onOperation);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
}
