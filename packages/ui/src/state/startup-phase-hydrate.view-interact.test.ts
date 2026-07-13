// @vitest-environment jsdom

/**
 * The ready-phase view-interact wiring (`startup-phase-hydrate.bindReadyPhase`):
 * agent-driven navigate-view WS events are dispatched to the shell and
 * view-interact requests are forwarded. jsdom with the API client and
 * view-interact dispatch mocked — no live agent.
 */
import {
  NAVIGATE_VIEW_EVENT,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
} from "@elizaos/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
} from "../api";
import { APP_EMOTE_EVENT, VOICE_CONTROL_EVENT } from "../events";
import { bindReadyPhase, type ReadyPhaseDeps } from "./startup-phase-hydrate";

const clientMock = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  return {
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    getCodingAgentStatus: vi.fn(
      async (): Promise<{ tasks: CodingAgentSession[] }> => ({ tasks: [] }),
    ),
    handlers,
    onWsEvent: vi.fn(
      (event: string, handler: (data: Record<string, unknown>) => void) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      },
    ),
    sendWsMessage: vi.fn(),
  };
});

const viewInteractMock = vi.hoisted(() => ({
  dispatchViewInteract: vi.fn(async () => {}),
}));

const viewRecoveryMock = vi.hoisted(() => ({
  recoverMissedCurrentView: vi.fn(async () => false),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../components/views/view-interact-registry", () => viewInteractMock);

vi.mock("../view-action-handoff", () => viewRecoveryMock);

vi.mock("@elizaos/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/logger")>()),
  logger: loggerMock,
}));

function makeDeps(): ReadyPhaseDeps {
  return {
    setActionNotice: vi.fn(),
    setAgentStatusIfChanged: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    setSystemWarnings: vi.fn(),
    showRestartBanner: vi.fn(),
    setPtySessions: vi.fn(),
    hasPtySessionsRef: { current: false },
    agentRunningRef: { current: false },
    setTabRaw: vi.fn(),
    setConversationMessages: vi.fn(),
    setUnreadConversations: vi.fn(),
    setConversations: vi.fn(),
    appendAutonomousEvent: vi.fn(),
    notifyHeartbeatEvent: vi.fn(),
    loadPlugins: vi.fn(async () => {}),
    loadWalletConfig: vi.fn(async () => {}),
    pollCloudCredits: vi.fn(),
    activeConversationIdRef: { current: null },
    elizaCloudPollInterval: { current: null },
    elizaCloudLoginPollTimer: { current: null },
  };
}

function applyStateUpdate<T>(current: T, update: T | ((previous: T) => T)): T {
  return typeof update === "function"
    ? (update as (previous: T) => T)(current)
    : update;
}

describe("bindReadyPhase pty hydration readiness gate", () => {
  it("only polls coding-agent status once the agent is running", () => {
    clientMock.getCodingAgentStatus.mockClear();
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const cleanup = bindReadyPhase({ current: deps });

      // Agent not running: the periodic poll must not touch the orchestrator/ACP
      // routes (they 404/503 during the boot window).
      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).not.toHaveBeenCalled();

      // Agent enters "running": the poll's catch-all hydrates exactly once.
      deps.agentRunningRef.current = true;
      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).toHaveBeenCalledTimes(1);

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bindReadyPhase view interaction bridge", () => {
  beforeEach(() => {
    clientMock.handlers.clear();
    clientMock.connectWs.mockClear();
    clientMock.disconnectWs.mockClear();
    clientMock.getCodingAgentStatus.mockClear();
    clientMock.onWsEvent.mockClear();
    clientMock.sendWsMessage.mockClear();
    viewInteractMock.dispatchViewInteract.mockClear();
    viewRecoveryMock.recoverMissedCurrentView.mockReset();
    viewRecoveryMock.recoverMissedCurrentView.mockResolvedValue(false);
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
  });

  it("recovers a missed agent view switch after the websocket reconnects", async () => {
    let recoveredView = false;
    let walletRefreshes = 0;
    let creditRefreshes = 0;
    viewRecoveryMock.recoverMissedCurrentView.mockImplementationOnce(
      async () => {
        recoveredView = true;
        return true;
      },
    );
    const deps = makeDeps();
    deps.loadWalletConfig = vi.fn(async () => {
      walletRefreshes += 1;
    });
    deps.pollCloudCredits = vi.fn(() => {
      creditRefreshes += 1;
    });
    const cleanup = bindReadyPhase({ current: deps });

    clientMock.handlers.get("ws-reconnected")?.({});

    await vi.waitFor(() =>
      expect({ recoveredView, walletRefreshes, creditRefreshes }).toEqual({
        recoveredView: true,
        walletRefreshes: 1,
        creditRefreshes: 1,
      }),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();

    cleanup();
  });

  it("observes reconnect recovery failures and retries on the next lifecycle event", async () => {
    const recoveryError = new Error("current view route unavailable");
    let recoveryAttempts = 0;
    viewRecoveryMock.recoverMissedCurrentView
      .mockImplementationOnce(async () => {
        recoveryAttempts += 1;
        throw recoveryError;
      })
      .mockImplementationOnce(async () => {
        recoveryAttempts += 1;
        return true;
      });
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("ws-reconnected")?.({});

    await vi.waitFor(() => {
      const reportedWarnings = loggerMock.warn.mock.calls.map(
        ([context, message]) => ({ context, message }),
      );
      expect(reportedWarnings).toEqual([
        {
          context: { error: recoveryError },
          message: "[startup] current view recovery failed",
        },
      ]);
    });

    clientMock.handlers.get("ws-reconnected")?.({});
    await vi.waitFor(() => expect(recoveryAttempts).toBe(2));
    expect(loggerMock.warn.mock.calls.map(([, message]) => message)).toEqual([
      "[startup] current view recovery failed",
    ]);

    cleanup();
  });

  it("applies status, warning, and restart websocket state transitions", async () => {
    let pendingRestart = true;
    let pendingReasons = ["old reason"];
    let systemWarnings = Array.from(
      { length: 50 },
      (_, index) => `warning-${index}`,
    );
    const deps = makeDeps();
    deps.setPendingRestart = vi.fn((update) => {
      pendingRestart = applyStateUpdate(pendingRestart, update);
    });
    deps.setPendingRestartReasons = vi.fn((update) => {
      pendingReasons = applyStateUpdate(pendingReasons, update);
    });
    deps.setSystemWarnings = vi.fn((update) => {
      systemWarnings = applyStateUpdate(systemWarnings, update);
    });
    const cleanup = bindReadyPhase({ current: deps });

    clientMock.handlers.get("system-warning")?.({ message: "warning-49" });
    expect(systemWarnings).toHaveLength(50);
    clientMock.handlers.get("system-warning")?.({ message: "latest warning" });
    expect(systemWarnings).toHaveLength(50);
    expect(systemWarnings.at(-1)).toBe("latest warning");
    expect(systemWarnings).not.toContain("warning-0");

    clientMock.handlers.get("status")?.({
      state: "running",
      agentName: "Eliza",
      restarted: true,
    });
    expect(deps.setAgentStatusIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({ state: "running", agentName: "Eliza" }),
    );
    expect(pendingRestart).toBe(false);
    expect(pendingReasons).toEqual([]);
    expect(deps.loadPlugins).toHaveBeenCalledTimes(1);
    expect(deps.loadWalletConfig).toHaveBeenCalledTimes(1);
    expect(deps.pollCloudCredits).toHaveBeenCalledTimes(1);

    clientMock.handlers.get("status")?.({
      state: "stopped",
      agentName: "Eliza",
      pendingRestart: true,
      pendingRestartReasons: ["plugin configuration", 42],
    });
    expect(pendingRestart).toBe(true);
    expect(pendingReasons).toEqual(["plugin configuration"]);

    clientMock.handlers.get("restart-required")?.({
      reasons: ["runtime update", false],
    });
    expect(pendingRestart).toBe(true);
    expect(pendingReasons).toEqual(["runtime update"]);
    expect(deps.showRestartBanner).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("routes emotes, view events, stream envelopes, and proactive messages into shell state", () => {
    let conversationMessages: ConversationMessage[] = [];
    let unreadConversations = new Set<string>();
    let conversations: Conversation[] = [
      {
        id: "active-conversation",
        title: "Pinned title",
        roomId: "active-room",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
      {
        id: "other-conversation",
        title: "Other",
        roomId: "other-room",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    ];
    const deps = makeDeps();
    deps.activeConversationIdRef.current = "active-conversation";
    deps.setConversationMessages = vi.fn((update) => {
      conversationMessages = applyStateUpdate(conversationMessages, update);
    });
    deps.setUnreadConversations = vi.fn((update) => {
      unreadConversations = applyStateUpdate(unreadConversations, update);
    });
    deps.setConversations = vi.fn((update) => {
      conversations = applyStateUpdate(conversations, update);
    });
    const emoteListener = vi.fn();
    const voiceListener = vi.fn();
    const viewEventListener = vi.fn();
    window.addEventListener(APP_EMOTE_EVENT, emoteListener);
    window.addEventListener(VOICE_CONTROL_EVENT, voiceListener);
    window.addEventListener("elizaos-view-event", viewEventListener);
    const cleanup = bindReadyPhase({ current: deps });

    clientMock.handlers.get("emote")?.({
      emoteId: "wave",
      path: "/emotes/wave.glb",
      loop: true,
      duration: 1200,
    });
    expect(emoteListener).toHaveBeenCalledTimes(1);

    clientMock.handlers.get("view:event")?.({
      viewEventType: "calendar:updated",
      payload: { eventId: "event-1" },
    });
    expect(viewEventListener).toHaveBeenCalledTimes(1);
    expect(
      (viewEventListener.mock.calls[0][0] as CustomEvent).detail,
    ).toMatchObject({
      type: "calendar:updated",
      payload: { eventId: "event-1" },
      sourceViewId: "agent",
    });

    clientMock.handlers.get("agent_event")?.({
      stream: "voice-control",
      payload: { command: "start" },
    });
    expect(voiceListener).toHaveBeenCalledTimes(1);
    clientMock.handlers.get("agent_event")?.({
      type: "agent_event",
      eventId: "agent-event-1",
      ts: 100,
      stream: "trajectory",
      payload: { summary: "working" },
    });
    clientMock.handlers.get("heartbeat_event")?.({
      type: "heartbeat_event",
      eventId: "heartbeat-1",
      ts: 101,
      payload: { status: "alive" },
    });
    expect(deps.appendAutonomousEvent).toHaveBeenCalledTimes(2);
    expect(deps.notifyHeartbeatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "heartbeat-1" }),
    );

    clientMock.handlers.get("proactive-message")?.({
      conversationId: "active-conversation",
      message: {
        id: "proactive-active",
        role: "user",
        text: "Calendar reminder",
        timestamp: 102,
        source: "calendar",
        from: "Calendar",
      },
    });
    expect(conversationMessages.map((message) => message.id)).toEqual([
      "proactive-active",
    ]);
    expect(deps.appendAutonomousEvent).toHaveBeenCalledTimes(3);

    clientMock.handlers.get("proactive-message")?.({
      conversationId: "other-conversation",
      message: {
        id: "proactive-unread",
        role: "assistant",
        text: "Background update",
        timestamp: 103,
      },
    });
    expect(unreadConversations).toEqual(new Set(["other-conversation"]));

    clientMock.handlers.get("conversation-updated")?.({
      conversation: {
        id: "active-conversation",
        title: "New Chat",
        roomId: "active-room",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T01:00:00.000Z",
      },
    });
    expect(
      conversations.find(({ id }) => id === "active-conversation")?.title,
    ).toBe("Pinned title");

    cleanup();
    window.removeEventListener(APP_EMOTE_EVENT, emoteListener);
    window.removeEventListener(VOICE_CONTROL_EVENT, voiceListener);
    window.removeEventListener("elizaos-view-event", viewEventListener);
  });

  it("maintains coding-session state across the websocket lifecycle", async () => {
    let sessions: CodingAgentSession[] = [];
    const deps = makeDeps();
    deps.agentRunningRef.current = true;
    deps.setPtySessions = vi.fn((update) => {
      sessions = applyStateUpdate(sessions, update);
    });
    const cleanup = bindReadyPhase({ current: deps });

    clientMock.handlers.get("pty-session-event")?.({
      eventType: "task_registered",
      sessionId: "session-1",
      data: {
        agentType: "codex",
        label: "Builder",
        originalTask: "Build a view",
        workdir: "/tmp/view",
      },
    });
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        status: "active",
        label: "Builder",
      }),
    ]);

    clientMock.handlers.get("pty-session-event")?.({
      eventType: "blocked",
      sessionId: "session-1",
      data: {},
    });
    expect(sessions[0]).toMatchObject({
      status: "blocked",
      lastActivity: "Waiting for input",
    });
    clientMock.handlers.get("pty-session-event")?.({
      eventType: "tool_running",
      sessionId: "session-1",
      data: { toolName: "typecheck" },
    });
    expect(sessions[0]).toMatchObject({
      status: "tool_running",
      toolDescription: "typecheck",
    });
    clientMock.handlers.get("pty-session-event")?.({
      eventType: "blocked_auto_resolved",
      sessionId: "session-1",
      data: { prompt: "Proceed with verification" },
    });
    expect(sessions[0]).toMatchObject({
      status: "active",
      lastActivity: "Approved: Proceed with verification",
    });
    clientMock.handlers.get("pty-session-event")?.({
      eventType: "coordination_decision",
      sessionId: "session-1",
      data: { action: "respond", reasoning: "Use the verified bundle" },
    });
    expect(sessions[0]?.lastActivity).toBe(
      "Responded: Use the verified bundle",
    );
    clientMock.handlers.get("pty-session-event")?.({
      eventType: "ready",
      sessionId: "session-1",
      data: {},
    });
    expect(sessions[0]).toMatchObject({
      status: "active",
      lastActivity: "Running",
    });
    clientMock.handlers.get("pty-session-event")?.({
      eventType: "error",
      sessionId: "session-1",
      data: { message: "Build failed" },
    });
    expect(sessions[0]).toMatchObject({
      status: "error",
      lastActivity: "Error: Build failed",
    });

    const recoveredSession: CodingAgentSession = {
      sessionId: "recovered-session",
      agentType: "codex",
      label: "Recovered builder",
      originalTask: "Verify the rebuilt view",
      workdir: "/tmp/recovered-view",
      status: "blocked",
      decisionCount: 2,
      autoResolvedCount: 1,
    };
    clientMock.getCodingAgentStatus.mockResolvedValueOnce({
      tasks: [recoveredSession],
    });
    clientMock.handlers.get("pty-session-event")?.({
      eventType: "ready",
      sessionId: "unknown-session",
      data: {},
    });
    await vi.waitFor(() => expect(sessions).toEqual([recoveredSession]));

    clientMock.handlers.get("pty-session-event")?.({
      eventType: "task_complete",
      sessionId: "session-1",
    });
    expect(sessions).toEqual([recoveredSession]);

    window.history.replaceState(null, "", "/settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(deps.setTabRaw).toHaveBeenCalledWith("settings");

    cleanup();
  });

  it("routes view:interact websocket events through the view dispatcher", async () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("view:interact")?.({
      requestId: "req-1",
      viewId: "remote-ledger",
      viewType: "gui",
      capability: "get-state",
      params: { selector: "[data-view-state]" },
    });

    await vi.waitFor(
      () =>
        expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledWith(
          "remote-ledger",
          "gui",
          "get-state",
          { selector: "[data-view-state]" },
          "req-1",
        ),
      { timeout: 10_000 },
    );

    cleanup();
    expect(clientMock.disconnectWs).toHaveBeenCalled();
    expect(clientMock.handlers.has("view:interact")).toBe(false);
  }, 60_000);

  it("routes future headset view:interact websocket events through the view dispatcher", async () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("view:interact")?.({
      requestId: "req-xr-1",
      viewId: "spatial-room",
      viewType: "xr",
      capability: "get-state",
    });

    await vi.waitFor(
      () =>
        expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledWith(
          "spatial-room",
          "xr",
          "get-state",
          undefined,
          "req-xr-1",
        ),
      { timeout: 10_000 },
    );

    cleanup();
  }, 60_000);

  it("ignores malformed view:interact websocket events before dispatch", async () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("view:interact")?.({
      requestId: "req-missing-view",
      capability: "get-state",
    });
    clientMock.handlers.get("view:interact")?.({
      requestId: "req-array-params",
      viewId: "remote-ledger",
      capability: "get-state",
      params: ["not", "an", "object"],
    });

    await vi.waitFor(
      () =>
        expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledWith(
          "remote-ledger",
          undefined,
          "get-state",
          undefined,
          "req-array-params",
        ),
      { timeout: 10_000 },
    );
    expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledTimes(1);

    cleanup();
    expect(clientMock.handlers.has("view:interact")).toBe(false);
  }, 60_000);

  it("dispatches valid shell:navigate:view events to the browser shell", () => {
    const navHandler = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get(SHELL_NAVIGATE_VIEW_WS_EVENT)?.({
      viewId: "remote-ledger",
      viewPath: "/views/remote-ledger",
      viewLabel: "Remote Ledger",
      viewType: "gui",
      action: "pin-tab",
      alwaysOnTop: true,
    });

    expect(navHandler).toHaveBeenCalledTimes(1);
    const event = navHandler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      viewId: "remote-ledger",
      viewPath: "/views/remote-ledger",
      viewLabel: "Remote Ledger",
      viewType: "gui",
      action: "pin-tab",
      alwaysOnTop: true,
    });

    cleanup();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  });

  it("dispatches valid XR shell:navigate:view events to the browser shell", () => {
    const navHandler = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get(SHELL_NAVIGATE_VIEW_WS_EVENT)?.({
      viewId: "spatial-room",
      viewPath: "/apps/spatial-room",
      viewLabel: "Spatial Room",
      viewType: "xr",
    });

    expect(navHandler).toHaveBeenCalledTimes(1);
    const event = navHandler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      viewId: "spatial-room",
      viewPath: "/apps/spatial-room",
      viewLabel: "Spatial Room",
      viewType: "xr",
      action: undefined,
      alwaysOnTop: false,
    });

    cleanup();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  });

  it("normalizes malformed shell:navigate:view fields before dispatch", () => {
    const navHandler = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get(SHELL_NAVIGATE_VIEW_WS_EVENT)?.({
      viewId: 12,
      viewPath: false,
      viewLabel: null,
      viewType: "web",
      action: ["pin-tab"],
      alwaysOnTop: "true",
    });

    expect(navHandler).toHaveBeenCalledTimes(1);
    const event = navHandler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      viewId: undefined,
      viewPath: undefined,
      viewLabel: undefined,
      viewType: undefined,
      action: undefined,
      alwaysOnTop: false,
    });

    cleanup();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  });
});
