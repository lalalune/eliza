/**
 * Exercises the real ChatView inbox-send handler with an account-selected
 * connector hook. Peripheral chat state and the composer rendering are isolated
 * so the assertion stays focused on the authenticated HTTP request boundary.
 */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import "../../api/client-chat";
import type { AgentRequestTransport } from "../../api/transport";

const mocks = vi.hoisted(() => ({
  client: {
    getInboxMessages: vi.fn(),
    sendInboxMessage: vi.fn(),
  },
  selectedAccount: {
    id: "discord-owner",
    enabled: true,
    status: "connected",
  },
}));

const appState = {
  agentStatus: { state: "running", canRespond: true },
  activeConversationId: null,
  activeInboxChat: {
    canSend: true,
    id: "discord-room-1",
    source: "discord",
    title: "Release room",
  },
  activeTerminalSessionId: null,
  characterData: { name: "Eliza" },
  chatFirstTokenReceived: false,
  companionMessageCutoffTs: null,
  handleChatSend: vi.fn(async () => {}),
  handleChatStop: vi.fn(),
  interruptActiveChatPipeline: vi.fn(),
  handleChatEdit: vi.fn(async () => true),
  handleChatDelete: vi.fn(async () => {}),
  elizaCloudConnected: false,
  elizaCloudVoiceProxyAvailable: false,
  elizaCloudHasPersistedKey: false,
  setState: vi.fn(),
  copyToClipboard: vi.fn(async () => {}),
  droppedFiles: [],
  analysisMode: false,
  shareIngestNotice: "",
  chatAgentVoiceMuted: true,
  uiLanguage: "en",
  sendChatText: vi.fn(async () => {}),
  t: (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
  setActionNotice: vi.fn(),
};

vi.mock("../../api/client", () => ({ client: mocks.client }));

vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (selector: (state: typeof appState) => unknown) =>
    selector(appState),
}));

vi.mock("../../state/ConversationMessagesContext.hooks", () => ({
  useConversationMessages: () => ({
    conversationMessages: [],
    removeConversationMessage: vi.fn(),
    prependConversationMessages: vi.fn(),
  }),
}));

vi.mock("../../state/ChatComposerContext.hooks", () => ({
  useChatComposer: () => ({
    chatInput: "",
    chatSending: false,
    chatPendingImages: [],
    chatReplyTarget: null,
    setChatInput: vi.fn(),
    setChatPendingImages: vi.fn(),
    setChatReplyTarget: vi.fn(),
  }),
}));

vi.mock("../../state/PtySessionsContext.hooks", () => ({
  usePtySessions: () => ({ ptySessions: [] }),
}));

vi.mock("../../hooks/useChatAvatarVoiceBridge", () => ({
  useChatAvatarVoiceBridge: () => {},
}));

vi.mock("../../hooks/useConnectorSendAsAccount", () => ({
  useConnectorSendAsAccount: () => ({
    context: {
      provider: "discord",
      connectorId: "discord",
      source: "discord",
      channel: "discord-room-1",
    },
    accounts: [mocks.selectedAccount],
    loading: false,
    error: null,
    saving: new Set<string>(),
    selectedAccount: mocks.selectedAccount,
    selectedAccountId: mocks.selectedAccount.id,
    sendAsMetadata: {
      connectorSendAs: {
        accountId: mocks.selectedAccount.id,
        channel: "discord-room-1",
        provider: "discord",
      },
    },
    showPicker: false,
    accountRequired: false,
    accountRequiredReason: null,
    selectAccount: vi.fn(),
    connectAccount: vi.fn(async () => ({})),
    reconnectAccount: vi.fn(async () => ({})),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("../composites/chat/chat-composer", () => ({
  ChatComposer: ({
    chatInput,
    onChatInputChange,
    onSend,
  }: {
    chatInput: string;
    onChatInputChange: (value: string) => void;
    onSend: () => void;
  }) => (
    <div>
      <textarea
        aria-label="Inbox reply"
        value={chatInput}
        onChange={(event) => onChatInputChange(event.currentTarget.value)}
      />
      <button type="button" onClick={onSend}>
        Send reply
      </button>
    </div>
  ),
}));

vi.mock("./chat-view-hooks", () => ({
  useChatVoiceController: () => ({
    beginVoiceCapture: vi.fn(),
    endVoiceCapture: vi.fn(),
    continuous: {
      status: "idle",
      interimTranscript: "",
      latency: null,
      needsAudioUnlock: false,
      unlockAudio: vi.fn(),
      micReconnected: false,
      ttsError: null,
    },
    handleEditMessage: vi.fn(),
    handleSpeakMessage: vi.fn(),
    stopSpeaking: vi.fn(),
    voice: {
      supported: false,
      isListening: false,
      isSpeaking: false,
      captureMode: "idle",
      interimTranscript: "",
      assistantTtsQuality: undefined,
      mouthOpen: 0,
    },
    voiceLatency: null,
    voiceSpeaker: null,
  }),
  useGameModalMessages: () => ({
    companionCarryover: null,
    gameModalCarryoverOpacity: 1,
    gameModalVisibleMsgs: [],
  }),
}));

import { ChatView } from "./ChatView";

afterEach(() => {
  cleanup();
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom must seed the exact cookie API the inbox client reads.
  document.cookie = "eliza_csrf=; Max-Age=0; Path=/";
});

describe("ChatView inbox account routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getInboxMessages.mockResolvedValue({ messages: [], count: 0 });
    mocks.client.sendInboxMessage.mockResolvedValue({ ok: true });
  });

  it("sends only the selected accountId across the strict inbox boundary", async () => {
    render(<ChatView />);

    await waitFor(() => {
      expect(mocks.client.getInboxMessages).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText("Inbox reply"), {
      target: { value: "  ship it  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => {
      expect(mocks.client.sendInboxMessage).toHaveBeenCalledWith({
        accountId: "discord-owner",
        roomId: "discord-room-1",
        source: "discord",
        text: "ship it",
      });
    });

    const request = mocks.client.sendInboxMessage.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty("channel");
    expect(request).not.toHaveProperty("metadata");
    expect(request).not.toHaveProperty("connectorSendAs");
  });
});

describe("inbox mutation transport", () => {
  it("mirrors the browser CSRF cookie and includes session credentials", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom must seed the exact cookie API the inbox client reads.
    document.cookie = "eliza_csrf=inbox-csrf-token; Path=/";
    const request = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    );
    const transport: AgentRequestTransport = {
      request,
    };
    const inboxClient = new ElizaClient("https://example.test");
    inboxClient.setRequestTransport(transport);

    await inboxClient.sendInboxMessage({
      accountId: "discord-owner",
      roomId: "discord-room-1",
      source: "discord",
      text: "ship it",
    });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/api/inbox/messages");
    expect(init).toMatchObject({ credentials: "include", method: "POST" });
    expect(new Headers(init?.headers).get("x-eliza-csrf")).toBe(
      "inbox-csrf-token",
    );
  });
});
