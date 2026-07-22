/**
 * Drives the native-composer hook through its real DOM transport and durable
 * store. The mutable model mirrors AppContext's synchronously-updated refs, so
 * conversation switches and typing during an unresolved send exercise the
 * production reconciliation boundary rather than a shadow test state.
 */
// @vitest-environment jsdom

import type { ChatSendResult } from "@elizaos/shared";
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
  type NativeComposerUiState,
  nativeComposerSnapshotStorageKey,
  useNativeComposerBridge,
} from "./useNativeComposerBridge";

vi.mock("@elizaos/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

let online = true;

function accepted(
  clientMessageId: string,
  conversationId = "conversation-a",
  userMessageId = "user-memory-1",
): ChatSendResult {
  return {
    status: "accepted",
    receipt: { conversationId, clientMessageId, userMessageId },
    completed: true,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface BridgeModel {
  state: NativeComposerUiState;
  options: () => NativeComposerBridgeOptions;
  sendChatText: NativeComposerBridgeOptions["sendChatText"];
  setChatInput: NativeComposerBridgeOptions["setChatInput"];
  setChatPendingImages: NativeComposerBridgeOptions["setChatPendingImages"];
  setChatReplyTarget: NativeComposerBridgeOptions["setChatReplyTarget"];
  interruptActiveChatPipeline: NativeComposerBridgeOptions["interruptActiveChatPipeline"];
}

function createModel(
  initial: Partial<NativeComposerUiState> = {},
  sendChatText?: NativeComposerBridgeOptions["sendChatText"],
): BridgeModel {
  let model: BridgeModel;
  model = {
    state: {
      activeConversationId: "conversation-a",
      chatInput: "",
      chatPendingImages: [],
      chatReplyTarget: null,
      ...initial,
    } as NativeComposerUiState,
    sendChatText: vi.fn(
      sendChatText ??
        (async (_text, options) =>
          accepted(
            options?.clientMessageId ?? "missing-client-id",
            options?.conversationId ?? "conversation-created",
          )),
    ),
    setChatInput: vi.fn((text: string) => {
      model.state = { ...model.state, chatInput: text };
    }),
    setChatPendingImages: vi.fn((images) => {
      model.state = { ...model.state, chatPendingImages: images };
    }),
    setChatReplyTarget: vi.fn((target) => {
      model.state = { ...model.state, chatReplyTarget: target };
    }),
    interruptActiveChatPipeline: vi.fn(),
    options: () => ({
      ...model.state,
      getCurrentComposerState: () => model.state,
      sendChatText: model.sendChatText,
      setChatInput: model.setChatInput,
      setChatPendingImages: model.setChatPendingImages,
      setChatReplyTarget: model.setChatReplyTarget,
      interruptActiveChatPipeline: model.interruptActiveChatPipeline,
      onPersistenceError: vi.fn(),
    }),
  } satisfies BridgeModel;
  return model;
}

function renderModel(model: BridgeModel): ReturnType<typeof renderHook> {
  return renderHook(() => useNativeComposerBridge(model.options()));
}

function dispatch(raw: unknown): void {
  act(() => dispatchNativeComposerOperation(raw));
}

function rendererEvents(): {
  events: unknown[];
  stop: () => void;
} {
  const events: unknown[] = [];
  const listener = (event: Event): void => {
    events.push((event as CustomEvent<unknown>).detail);
  };
  window.addEventListener(NATIVE_COMPOSER_RENDERER_EVENT, listener);
  return {
    events,
    stop: () =>
      window.removeEventListener(NATIVE_COMPOSER_RENDERER_EVENT, listener),
  };
}

function persistedDraft(scope: string): { text?: unknown } | undefined {
  const raw = window.localStorage.getItem(
    nativeComposerSnapshotStorageKey("web"),
  );
  const store = JSON.parse(raw ?? "null") as {
    schema?: unknown;
    sessions?: Record<string, { draft?: { text?: unknown } }>;
  } | null;
  expect(store?.schema).toBe("eliza.native-composer-session-store/v1");
  return store?.sessions?.[scope]?.draft;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.__ELIZA_NATIVE_COMPOSER_QUEUE__ = [];
  document.body.replaceChildren();
  online = true;
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
});

describe("useNativeComposerBridge state reconciliation", () => {
  it("round-trips native and manual edits through the authoritative UI", () => {
    const model = createModel();
    const view = renderModel(model);

    dispatch({ type: "text.set", opId: "native-text", text: "from native" });
    expect(model.state.chatInput).toBe("from native");
    view.rerender();

    act(() => {
      model.setChatInput("edited manually");
      view.rerender();
    });
    expect(persistedDraft("conversation-a")?.text).toBe("edited manually");

    dispatch({ type: "text.insert", opId: "native-more", text: " + native" });
    expect(model.state.chatInput).toBe("edited manually + native");
  });

  it("keeps snapshots and operation ledgers scoped to each conversation", () => {
    const model = createModel({ chatInput: "draft a" });
    const view = renderModel(model);
    expect(persistedDraft("conversation-a")?.text).toBe("draft a");

    act(() => {
      model.state = {
        ...model.state,
        activeConversationId: "conversation-b",
        chatInput: "draft b",
      };
      view.rerender();
    });
    dispatch({ type: "text.insert", opId: "b-op", text: "!" });
    expect(model.state.chatInput).toBe("draft b!");

    act(() => {
      model.state = {
        ...model.state,
        activeConversationId: "conversation-a",
        chatInput: "draft a",
      };
      view.rerender();
    });
    expect(model.state.chatInput).toBe("draft a");
    expect(persistedDraft("conversation-a")?.text).toBe("draft a");
    expect(persistedDraft("conversation-b")?.text).toBe("draft b!");
  });

  it("assigns stable UI attachment identity and keeps accepted data visible", () => {
    const model = createModel({
      chatPendingImages: [
        { data: "aGVsbG8=", mimeType: "text/plain", name: "hello.txt" },
      ],
    });
    const view = renderModel(model);
    view.rerender();
    const identity = model.state.chatPendingImages[0]?.clientAttachmentId;
    expect(identity).toMatch(/^legacy-/);

    dispatch({
      type: "text.insert",
      opId: "keep-attachment",
      text: "caption",
    });
    expect(model.state.chatPendingImages[0]?.clientAttachmentId).toBe(identity);
    expect(model.state.chatPendingImages[0]?.data).toBe("aGVsbG8=");
  });

  it("replaces same-id data without retaining a stale thumbnail", () => {
    const model = createModel({
      chatPendingImages: [
        {
          clientAttachmentId: "native-attachment",
          data: "b2xk",
          mimeType: "text/plain",
          name: "old.txt",
          thumbnail: { data: "old-thumb", mimeType: "image/jpeg" },
        },
      ],
    });
    renderModel(model);

    dispatch({
      type: "attachment.add",
      opId: "replace-attachment",
      attachmentId: "native-attachment",
      attachment: {
        source: "data-url",
        dataUrl: "data:text/plain;base64,bmV3",
        name: "new.txt",
      },
    });

    expect(model.state.chatPendingImages).toEqual([
      {
        clientAttachmentId: "native-attachment",
        data: "bmV3",
        mimeType: "text/plain",
        name: "new.txt",
      },
    ]);
  });
});

describe("useNativeComposerBridge send truth", () => {
  it("preserves text typed while sending and reports the exact memory receipt", async () => {
    const pending = deferred<ChatSendResult>();
    const model = createModel({}, async () => pending.promise);
    const view = renderModel(model);
    const observed = rendererEvents();
    dispatch({ type: "text.set", opId: "seed", text: "submitted" });
    view.rerender();
    dispatch({ type: "send", opId: "native-send" });
    await waitFor(() => expect(model.sendChatText).toHaveBeenCalledTimes(1));

    act(() => {
      model.setChatInput("typed while sending");
      view.rerender();
    });
    pending.resolve(
      accepted("native-send", "conversation-a", "actual-user-memory"),
    );

    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "send.result",
        opId: "native-send",
        outcome: accepted(
          "native-send",
          "conversation-a",
          "actual-user-memory",
        ),
      }),
    );
    expect(model.state.chatInput).toBe("typed while sending");
    expect(persistedDraft("conversation-a")?.text).toBe("typed while sending");
    observed.stop();
  });

  it("clears only an unchanged accepted draft and never fabricates the op id", async () => {
    const model = createModel();
    const view = renderModel(model);
    const observed = rendererEvents();
    dispatch({ type: "text.set", opId: "seed", text: "send me" });
    view.rerender();
    dispatch({ type: "send", opId: "native-send" });

    await waitFor(() => expect(model.state.chatInput).toBe(""));
    expect(observed.events).toContainEqual({
      type: "send.result",
      opId: "native-send",
      outcome: accepted("native-send", "conversation-a", "user-memory-1"),
    });
    observed.stop();
  });

  it("keeps a failed draft and surfaces a typed failure", async () => {
    const failure: ChatSendResult = {
      status: "failed",
      conversationId: "conversation-a",
      clientMessageId: "native-send",
      reason: "generation",
      message: "model unavailable",
      retryable: true,
    };
    const model = createModel({}, async () => failure);
    const view = renderModel(model);
    const observed = rendererEvents();
    dispatch({ type: "text.set", opId: "seed", text: "keep me" });
    view.rerender();
    dispatch({ type: "send", opId: "native-send" });

    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "send.result",
        opId: "native-send",
        outcome: failure,
      }),
    );
    expect(model.state.chatInput).toBe("keep me");
    observed.stop();
  });

  it("rejects an accepted receipt that belongs to another logical send", async () => {
    const model = createModel({}, async () =>
      accepted("different-send", "conversation-a"),
    );
    const view = renderModel(model);
    const observed = rendererEvents();
    dispatch({ type: "text.set", opId: "seed", text: "keep me" });
    view.rerender();
    dispatch({ type: "send", opId: "native-send" });

    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "send.result",
        opId: "native-send",
        outcome: {
          status: "failed",
          conversationId: "conversation-a",
          clientMessageId: "native-send",
          reason: "missing-receipt",
          message: "The chat boundary returned a receipt for a different send.",
          retryable: true,
        },
      }),
    );
    expect(model.state.chatInput).toBe("keep me");
    observed.stop();
  });

  it("reports cancellation, interrupts the real pipeline, and ignores late success", async () => {
    const pending = deferred<ChatSendResult>();
    const model = createModel({}, async () => pending.promise);
    const view = renderModel(model);
    const observed = rendererEvents();
    dispatch({ type: "text.set", opId: "seed", text: "cancel me" });
    view.rerender();
    dispatch({ type: "send", opId: "native-send" });
    await waitFor(() => expect(model.sendChatText).toHaveBeenCalledTimes(1));
    dispatch({ type: "cancel", opId: "cancel-op", scope: "send" });

    expect(model.interruptActiveChatPipeline).toHaveBeenCalledTimes(1);
    expect(observed.events).toContainEqual({
      type: "send.result",
      opId: "native-send",
      outcome: {
        status: "cancelled",
        conversationId: "conversation-a",
        clientMessageId: "native-send",
        message: "Send cancelled by the native composer.",
      },
    });
    pending.resolve(accepted("native-send"));
    await act(async () => pending.promise);
    expect(
      observed.events.filter(
        (event) => (event as { type?: unknown }).type === "send.result",
      ),
    ).toHaveLength(1);
    expect(model.state.chatInput).toBe("cancel me");
    observed.stop();
  });

  it("does not let a delayed send from conversation A clear conversation B", async () => {
    const pending = deferred<ChatSendResult>();
    const model = createModel({}, async () => pending.promise);
    const view = renderModel(model);
    const observed = rendererEvents();
    dispatch({ type: "text.set", opId: "seed", text: "from a" });
    view.rerender();
    dispatch({ type: "send", opId: "native-send" });
    await waitFor(() => expect(model.sendChatText).toHaveBeenCalledTimes(1));

    act(() => {
      model.state = {
        ...model.state,
        activeConversationId: "conversation-b",
        chatInput: "draft b",
      };
      view.rerender();
    });
    pending.resolve(accepted("native-send", "conversation-a"));
    await act(async () => pending.promise);
    expect(model.state).toEqual(
      expect.objectContaining({
        activeConversationId: "conversation-b",
        chatInput: "draft b",
      }),
    );
    expect(observed.events).toContainEqual({
      type: "send.result",
      opId: "native-send",
      outcome: accepted("native-send", "conversation-a"),
    });
    observed.stop();
  });

  it("follows a server-confirmed conversation recovery without losing edit guards", async () => {
    const pending = deferred<ChatSendResult>();
    const model = createModel({}, async () => pending.promise);
    const view = renderModel(model);
    dispatch({ type: "text.set", opId: "seed", text: "recover me" });
    view.rerender();
    dispatch({ type: "send", opId: "native-send" });
    await waitFor(() => expect(model.sendChatText).toHaveBeenCalledTimes(1));

    act(() => {
      model.state = {
        ...model.state,
        activeConversationId: "conversation-recovered",
      };
      view.rerender();
    });
    pending.resolve(accepted("native-send", "conversation-recovered"));
    await act(async () => pending.promise);

    expect(model.state).toMatchObject({
      activeConversationId: "conversation-recovered",
      chatInput: "",
    });
  });
});

describe("useNativeComposerBridge observed shell state", () => {
  it("does not echo requested focus or voice before the DOM observes them", async () => {
    const textarea = document.createElement("textarea");
    textarea.dataset.testid = "chat-composer-textarea";
    document.body.append(textarea);
    const model = createModel();
    const view = renderModel(model);
    const observed = rendererEvents();

    dispatch({
      type: "focus.set",
      opId: "focus-op",
      focused: true,
      keyboard: "shown",
    });
    expect(
      observed.events.some(
        (event) => (event as { type?: unknown }).type === "focus.changed",
      ),
    ).toBe(false);
    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "focus.changed",
        focused: true,
        keyboard: "hidden",
      }),
    );

    dispatch({ type: "voice.handoff", opId: "voice", phase: "start" });
    expect(
      observed.events.some(
        (event) => (event as { type?: unknown }).type === "voice.state",
      ),
    ).toBe(false);
    const badge = document.createElement("div");
    badge.dataset.testid = "chat-transcribing-badge";
    document.body.append(badge);
    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "voice.state",
        phase: "start",
      }),
    );
    dispatch({
      type: "voice.handoff",
      opId: "voice-commit",
      phase: "commit",
      transcript: "spoken text",
    });
    expect(observed.events).not.toContainEqual({
      type: "voice.state",
      phase: "commit",
    });
    view.rerender();
    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "voice.state",
        phase: "commit",
      }),
    );
    observed.stop();
  });

  it("waits for the observed badge exit when a voice commit changes no text", async () => {
    const badge = document.createElement("div");
    badge.dataset.testid = "chat-transcribing-badge";
    document.body.append(badge);
    const model = createModel({ chatInput: "unchanged" });
    const observed = rendererEvents();
    renderModel(model);
    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "voice.state",
        phase: "start",
      }),
    );

    dispatch({
      type: "voice.handoff",
      opId: "voice-same-commit",
      phase: "commit",
    });
    expect(observed.events).not.toContainEqual({
      type: "voice.state",
      phase: "commit",
    });
    badge.remove();
    await waitFor(() =>
      expect(observed.events).toContainEqual({
        type: "voice.state",
        phase: "commit",
      }),
    );
    observed.stop();
  });
});

describe("useNativeComposerBridge durability", () => {
  it("settles a cancelled deferred send and never replays it", async () => {
    online = false;
    const model = createModel({ chatInput: "cancel while offline" });
    renderModel(model);
    const observed = rendererEvents();

    dispatch({ type: "send", opId: "offline-cancelled-send" });
    dispatch({ type: "cancel", opId: "cancel-offline", scope: "send" });

    expect(observed.events).toContainEqual({
      type: "send.result",
      opId: "offline-cancelled-send",
      outcome: {
        status: "cancelled",
        conversationId: "conversation-a",
        clientMessageId: "offline-cancelled-send",
        message: "Send cancelled by the native composer.",
      },
    });
    online = true;
    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => undefined);
    expect(model.sendChatText).not.toHaveBeenCalled();
    observed.stop();
  });

  it("replays one deferred send after reload and dedupes redelivery", async () => {
    online = false;
    const firstModel = createModel({ chatInput: "send after reconnect" });
    const first = renderModel(firstModel);
    const send = { type: "send", opId: "offline-send" };
    dispatch(send);
    expect(firstModel.sendChatText).not.toHaveBeenCalled();
    first.unmount();

    online = true;
    const secondModel = createModel({ chatInput: "send after reconnect" });
    renderModel(secondModel);
    await waitFor(() =>
      expect(secondModel.sendChatText).toHaveBeenCalledTimes(1),
    );
    dispatch(send);
    await act(async () => undefined);
    expect(secondModel.sendChatText).toHaveBeenCalledTimes(1);
  });

  it("retains a host delivery until the conversation store is durable", () => {
    const acknowledgments: unknown[] = [];
    const listener = (event: Event): void => {
      acknowledgments.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT, listener);
    const storageWrite = vi
      .spyOn(shellLocalStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });
    const model = createModel();
    const first = renderModel(model);
    act(() =>
      dispatchNativeComposerOperation(
        { type: "text.set", opId: "quota-op", text: "retained" },
        "quota-delivery",
      ),
    );
    expect(acknowledgments).toEqual([]);
    expect(drainNativeComposerOperations()).toHaveLength(1);
    first.unmount();

    storageWrite.mockRestore();
    renderModel(model);
    expect(drainNativeComposerOperations()).toEqual([]);
    expect(acknowledgments).toContainEqual({
      deliveryId: "quota-delivery",
      disposition: "persisted",
      resultStatus: "applied",
    });
    window.removeEventListener(NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT, listener);
  });

  it("disposes invalid host input with an explicit rejection", () => {
    const acknowledgments: unknown[] = [];
    const listener = (event: Event): void => {
      acknowledgments.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT, listener);
    renderModel(createModel());
    act(() =>
      dispatchNativeComposerOperation(
        { type: "text.set", opId: "invalid", text: 42 },
        "invalid-delivery",
      ),
    );
    expect(acknowledgments).toContainEqual({
      deliveryId: "invalid-delivery",
      disposition: "rejected",
      resultStatus: "invalid-input",
      reason: "`text` must be a string",
    });
    expect(drainNativeComposerOperations()).toEqual([]);
    window.removeEventListener(NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT, listener);
  });
});
