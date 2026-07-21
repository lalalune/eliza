/**
 * Exercises the installed native-composer hook through its real DOM transport
 * and localStorage-backed reducer snapshot. The chat send itself remains the
 * deterministic boundary so reload, duplicate callback, reconnect, and failure
 * semantics can be asserted without a backend.
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchNativeComposerOperation,
  drainNativeComposerOperations,
  NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
  NATIVE_COMPOSER_RENDERER_EVENT,
} from "../native-composer";
import { shellLocalStorage } from "../surface-realm-channel";
import {
  type NativeComposerBridgeOptions,
  nativeComposerSnapshotStorageKey,
  useNativeComposerBridge,
} from "./useNativeComposerBridge";

vi.mock("@elizaos/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

let online = true;

function options(
  sendChatText: NativeComposerBridgeOptions["sendChatText"] = vi
    .fn()
    .mockResolvedValue(undefined),
): NativeComposerBridgeOptions {
  return {
    sendChatText,
    setChatInput: vi.fn(),
    setChatPendingImages: vi.fn(),
    setChatReplyTarget: vi.fn(),
    interruptActiveChatPipeline: vi.fn(),
    onPersistenceError: vi.fn(),
  };
}

function dispatch(raw: unknown): void {
  act(() => dispatchNativeComposerOperation(raw));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.__ELIZA_NATIVE_COMPOSER_QUEUE__ = [];
  online = true;
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
});

describe("useNativeComposerBridge durability", () => {
  it("hydrates the real composer and dedupes a redelivered callback after reload", () => {
    const firstOptions = options();
    const first = renderHook(() => useNativeComposerBridge(firstOptions));
    const operation = {
      type: "text.set",
      opId: "native-text-1",
      text: "survives reload",
    };
    dispatch(operation);

    expect(firstOptions.setChatInput).toHaveBeenLastCalledWith(
      "survives reload",
    );
    first.unmount();

    const secondOptions = options();
    renderHook(() => useNativeComposerBridge(secondOptions));
    expect(secondOptions.setChatInput).toHaveBeenCalledTimes(1);
    expect(secondOptions.setChatInput).toHaveBeenCalledWith("survives reload");

    dispatch({ ...operation });
    expect(secondOptions.setChatInput).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(
      window.localStorage.getItem(nativeComposerSnapshotStorageKey("web")) ??
        "null",
    ) as { processedOpIds?: unknown } | null;
    expect(persisted?.processedOpIds).toContain("native-text-1");
  });

  it("replays one deferred send after offline reload and ignores its duplicate callback", async () => {
    online = false;
    const firstOptions = options();
    const first = renderHook(() => useNativeComposerBridge(firstOptions));
    dispatch({
      type: "text.set",
      opId: "native-text-2",
      text: "send after reconnect",
    });
    const send = { type: "send", opId: "native-send-2" };
    dispatch(send);
    expect(firstOptions.sendChatText).not.toHaveBeenCalled();
    first.unmount();

    online = true;
    const replaySend = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useNativeComposerBridge(options(replaySend)));
    await waitFor(() => expect(replaySend).toHaveBeenCalledTimes(1));
    expect(replaySend).toHaveBeenCalledWith(
      "send after reconnect",
      expect.objectContaining({ clientMessageId: "native-send-2" }),
    );

    dispatch({ ...send });
    await act(async () => undefined);
    expect(replaySend).toHaveBeenCalledTimes(1);
  });

  it("reports a real send failure truthfully and keeps the draft durable", async () => {
    const events: unknown[] = [];
    const onRendererEvent = (event: Event): void => {
      events.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(NATIVE_COMPOSER_RENDERER_EVENT, onRendererEvent);
    const sendChatText = vi.fn().mockRejectedValue(new Error("server refused"));
    renderHook(() => useNativeComposerBridge(options(sendChatText)));
    dispatch({
      type: "text.set",
      opId: "native-text-3",
      text: "keep this draft",
    });
    dispatch({ type: "send", opId: "native-send-3" });

    await waitFor(() =>
      expect(events).toContainEqual({
        type: "send.result",
        opId: "native-send-3",
        outcome: {
          ok: false,
          reason: "send-failed",
          message: "server refused",
        },
      }),
    );
    const persisted = JSON.parse(
      window.localStorage.getItem(nativeComposerSnapshotStorageKey("web")) ??
        "null",
    ) as { draft?: { text?: unknown }; deferred?: unknown } | null;
    expect(persisted?.draft?.text).toBe("keep this draft");
    expect(persisted?.deferred).toEqual([]);
    window.removeEventListener(NATIVE_COMPOSER_RENDERER_EVENT, onRendererEvent);
  });

  it("retains a host delivery across quota failure, reloads it, and dedupes redelivery", () => {
    const acknowledgments: unknown[] = [];
    const onAcknowledgment = (event: Event): void => {
      acknowledgments.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(
      NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
      onAcknowledgment,
    );
    const storageWrite = vi
      .spyOn(shellLocalStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });
    const raw = {
      type: "text.set",
      opId: "quota-op",
      text: "retained by native host",
    };
    const first = renderHook(() => useNativeComposerBridge(options()));
    act(() => dispatchNativeComposerOperation(raw, "quota-delivery"));
    expect(acknowledgments).toEqual([]);
    expect(drainNativeComposerOperations()).toHaveLength(1);
    first.unmount();

    storageWrite.mockRestore();
    const recoveredOptions = options();
    const recovered = renderHook(() =>
      useNativeComposerBridge(recoveredOptions),
    );
    expect(recoveredOptions.setChatInput).toHaveBeenLastCalledWith(
      "retained by native host",
    );
    expect(drainNativeComposerOperations()).toEqual([]);
    expect(acknowledgments).toContainEqual({
      deliveryId: "quota-delivery",
      disposition: "persisted",
      resultStatus: "applied",
    });
    recovered.unmount();

    const duplicateOptions = options();
    renderHook(() => useNativeComposerBridge(duplicateOptions));
    expect(duplicateOptions.setChatInput).toHaveBeenCalledTimes(1);
    act(() => dispatchNativeComposerOperation(raw, "quota-redelivery"));
    expect(duplicateOptions.setChatInput).toHaveBeenCalledTimes(1);
    expect(acknowledgments).toContainEqual({
      deliveryId: "quota-redelivery",
      disposition: "persisted",
      resultStatus: "duplicate",
    });
    window.removeEventListener(
      NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
      onAcknowledgment,
    );
  });

  it("disposes an invalid host frame with an explicit rejection", () => {
    const acknowledgments: unknown[] = [];
    const onAcknowledgment = (event: Event): void => {
      acknowledgments.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(
      NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
      onAcknowledgment,
    );
    renderHook(() => useNativeComposerBridge(options()));

    act(() =>
      dispatchNativeComposerOperation(
        { type: "text.set", opId: "invalid", text: 42 },
        "invalid-delivery",
      ),
    );

    expect(drainNativeComposerOperations()).toEqual([]);
    expect(acknowledgments).toContainEqual({
      deliveryId: "invalid-delivery",
      disposition: "rejected",
      resultStatus: "invalid-input",
      reason: "`text` must be a string",
    });
    window.removeEventListener(
      NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
      onAcknowledgment,
    );
  });

  it("rejects an attachment that the real composer cannot visibly preview", () => {
    const acknowledgments: unknown[] = [];
    const onAcknowledgment = (event: Event): void => {
      acknowledgments.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(
      NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
      onAcknowledgment,
    );
    const bridgeOptions = options();
    renderHook(() => useNativeComposerBridge(bridgeOptions));

    act(() =>
      dispatchNativeComposerOperation(
        {
          type: "attachment.add",
          opId: "stored-attachment-op",
          attachmentId: "stored-attachment",
          attachment: {
            source: "stored",
            url: `/api/media/${"a".repeat(64)}.png`,
          },
        },
        "stored-attachment-delivery",
      ),
    );

    expect(bridgeOptions.setChatPendingImages).not.toHaveBeenCalled();
    expect(bridgeOptions.sendChatText).not.toHaveBeenCalled();
    expect(acknowledgments).toContainEqual({
      deliveryId: "stored-attachment-delivery",
      disposition: "rejected",
      resultStatus: "rejected",
      reason: "unsupported",
    });
    expect(drainNativeComposerOperations()).toEqual([]);
    window.removeEventListener(
      NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
      onAcknowledgment,
    );
  });
});
