/**
 * Boots the renderer through the ordinary interactive iOS path, then drives
 * the native lifecycle callbacks that the composition root owns: keyboard,
 * runtime-mode changes, and representative OS deep links.
 */
import { Capacitor } from "@capacitor/core";
import { runIosFullBunSmokeIfRequested } from "@elizaos/app-core";
import { client } from "@elizaos/ui/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const iosBoot = vi.hoisted(() => ({
  initializeStorage: vi.fn(async () => undefined),
  initializeCapacitor: vi.fn(),
  installNativeRequest: vi.fn(),
  installFetch: vi.fn(),
  render: vi.fn(),
  createRoot: vi.fn(),
  runEmbedHandshake: vi.fn(async () => undefined),
  registerServiceWorker: vi.fn(),
  keyboardListeners: new Map<string, (value?: unknown) => void>(),
  lifecycleDependencies: undefined as
    | { handleDeepLink: (url: string) => void }
    | undefined,
  initializeAppLifecycle: vi.fn(),
  initializeNetworkListener: vi.fn(async () => undefined),
  preferenceSet: vi.fn(
    async (_entry: { key: string; value: string }) => undefined,
  ),
}));

iosBoot.createRoot.mockReturnValue({ render: iosBoot.render });

vi.mock("react-dom/client", () => ({
  default: { createRoot: iosBoot.createRoot },
  createRoot: iosBoot.createRoot,
}));
vi.mock("@elizaos/ui/App", () => ({ App: () => null }));
vi.mock("@elizaos/ui/bridge/storage-bridge", () => ({
  initializeStorageBridge: iosBoot.initializeStorage,
  setStorageValue: vi.fn(async () => undefined),
}));
vi.mock("@elizaos/ui/bridge/capacitor-bridge", () => ({
  initializeCapacitorBridge: iosBoot.initializeCapacitor,
}));
vi.mock("@elizaos/app-core/api/ios-local-agent-transport", () => ({
  installIosLocalAgentNativeRequestBridge: iosBoot.installNativeRequest,
  installIosLocalAgentFetchBridge: iosBoot.installFetch,
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: iosBoot.preferenceSet,
    remove: vi.fn(async () => undefined),
  },
}));
vi.mock("@capacitor/background-runner", () => ({
  BackgroundRunner: { dispatchEvent: vi.fn(async () => undefined) },
}));
vi.mock("@capacitor/keyboard", () => ({
  KeyboardResize: { None: "none" },
  Keyboard: {
    setResizeMode: vi.fn(async () => undefined),
    setScroll: vi.fn(async () => undefined),
    setAccessoryBarVisible: vi.fn(async () => undefined),
    addListener: vi.fn((name: string, listener: (value?: unknown) => void) => {
      iosBoot.keyboardListeners.set(name, listener);
      return Promise.resolve({ remove: vi.fn(async () => undefined) });
    }),
  },
}));
vi.mock("@capacitor/status-bar", () => ({
  Style: { Dark: "dark" },
  StatusBar: {
    setStyle: vi.fn(async () => undefined),
    setOverlaysWebView: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(async () => undefined),
  },
}));
vi.mock("@elizaos/capacitor-agent", () => ({
  Agent: { getStatus: vi.fn(async () => ({ ready: true })) },
}));
vi.mock("./mobile-lifecycle", () => ({
  createMobileLifecycle: vi.fn(
    (dependencies: { handleDeepLink: (url: string) => void }) => {
      iosBoot.lifecycleDependencies = dependencies;
      return {
        initializeAppLifecycle: iosBoot.initializeAppLifecycle,
        initializeNetworkListener: iosBoot.initializeNetworkListener,
      };
    },
  ),
}));
vi.mock("./boot-voice-load", () => ({
  startVoiceModuleLoad: vi.fn(() =>
    Promise.resolve({
      installAecLoopHarness: vi.fn(),
      registerDesktopFusedWake: vi.fn(),
    }),
  ),
}));
vi.mock("./ios-attachment-smoke", () => ({
  runIosAttachmentSmokeIfRequested: vi.fn(async () => false),
}));
vi.mock("./ios-voice-selftest-smoke", () => ({
  runIosVoiceSelfTestSmokeIfRequested: vi.fn(async () => false),
}));
vi.mock("./keyboard-dictation", () => ({
  startKeyboardDictationSession: vi.fn(),
}));
vi.mock("./embed-bootstrap", () => ({
  runEmbedHandshake: iosBoot.runEmbedHandshake,
}));
vi.mock("./sw-registration", () => ({
  registerViewServiceWorker: iosBoot.registerServiceWorker,
}));

beforeEach(() => {
  vi.mocked(Capacitor.getPlatform).mockReturnValue("ios");
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(runIosFullBunSmokeIfRequested).mockResolvedValue(false);
  vi.stubGlobal("__ELIZA_BUILD_VARIANT__", "local");
  vi.stubGlobal("__ELIZA_WEB_SHELL__", false);
  vi.stubGlobal("__ELIZA_CHAT_UI_HARNESS__", false);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  vi.stubGlobal(
    "WebSocket",
    class TestWebSocket extends EventTarget {
      constructor(_url: string | URL) {
        super();
      }
    },
  );
  vi.spyOn(client, "getBaseUrl").mockReturnValue("http://127.0.0.1:31338");
  vi.spyOn(client, "repointBaseUrl").mockImplementation(() => undefined);
  vi.spyOn(client, "getConnectionState").mockReturnValue({
    state: "connected",
    reconnectAttempt: 0,
    maxReconnectAttempts: 10,
    disconnectedAt: null,
  });
  window.localStorage.clear();
  window.localStorage.setItem("eliza:mobile-runtime-mode", "local");
  window.localStorage.setItem(
    "eliza:ios-onboarding-smoke:request",
    JSON.stringify({ apiBase: "http://127.0.0.1:31338" }),
  );
  window.localStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      kind: "remote",
      apiBase: "http://127.0.0.1:31338",
    }),
  );
  document.body.innerHTML = [
    '<div id="root"></div>',
    '<div data-testid="home-launcher-surface" data-page="home"></div>',
    '<textarea data-testid="chat-composer-textarea"></textarea>',
  ].join("");
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-testid="home-launcher-surface"], [data-testid="chat-composer-textarea"]',
  )) {
    Object.defineProperty(element, "offsetParent", {
      value: document.body,
      configurable: true,
    });
  }
});

describe("renderer interactive iOS composition", () => {
  it("mounts and routes native callbacks through the shipped handlers", async () => {
    const main = await import("./main");
    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    await vi.waitFor(() => expect(iosBoot.render).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(iosBoot.initializeAppLifecycle).toHaveBeenCalledOnce(),
    );

    expect(main.isIOS).toBe(true);
    expect(main.isNative).toBe(true);
    expect(iosBoot.installNativeRequest).toHaveBeenCalledTimes(2);
    expect(iosBoot.installFetch).toHaveBeenCalledTimes(2);

    iosBoot.keyboardListeners.get("keyboardWillShow")?.({
      keyboardHeight: 321,
    });
    expect(document.body.style.getPropertyValue("--keyboard-height")).toBe(
      "321px",
    );
    iosBoot.keyboardListeners.get("keyboardWillHide")?.();
    expect(document.body.classList).not.toContain("keyboard-open");

    document.dispatchEvent(new Event("eliza:mobile-runtime-mode-changed"));

    const handleDeepLink = iosBoot.lifecycleDependencies?.handleDeepLink;
    expect(handleDeepLink).toBeTypeOf("function");
    window.localStorage.setItem(
      "eliza:auth-callback-smoke:request",
      JSON.stringify({ state: "smoke", code: "synthetic" }),
    );
    for (const url of [
      "not a url",
      "elizaos://settings",
      "elizaos://phone/call?contact=alice",
      "elizaos://messages/compose?to=bob",
      "elizaos://contacts",
      "elizaos://aec-loop?duration=1",
      "elizaos://keyboard-dictation",
      "elizaos://connect?url=http%3A%2F%2Flocalhost%3A2138",
      "elizaos://share?title=Hello&text=Body&file=%2Ftmp%2Fnote.txt",
      "elizaos://auth/callback?state=smoke&code=synthetic",
      "elizaos://unknown-path",
    ]) {
      handleDeepLink?.(url);
    }

    await vi.waitFor(() =>
      expect(iosBoot.preferenceSet).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "eliza:auth-callback-smoke:result",
          value: expect.stringContaining('"phase":"handled"'),
        }),
      ),
    );

    await vi.waitFor(
      () => {
        const mixedContentResult = iosBoot.preferenceSet.mock.calls
          .map(([entry]) => entry)
          .filter(
            (entry) => entry.key === "eliza:ios-mixed-content-smoke:result",
          )
          .at(-1);
        expect(mixedContentResult).toBeDefined();
        const result = JSON.parse(String(mixedContentResult?.value));
        expect(result).toMatchObject({
          ok: true,
          phase: "complete",
          expectedWebSocketUrl: "ws://127.0.0.1:31338/ws",
          webSocketExpected: false,
          webSocketConstructorCalls: [],
          webSocketOpenCalls: [],
          connectionState: { state: "connected" },
          restHealth: { ok: true, status: 200 },
        });
      },
      { timeout: 3_000 },
    );
    expect(client.repointBaseUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:31338",
    );

    expect(window.location.hash).toContain("aec-loop");
    expect(window.__ELIZA_APP_SHARE_QUEUE__).toEqual([
      expect.objectContaining({
        source: "deep-link",
        title: "Hello",
        files: [{ name: "note.txt", path: "/tmp/note.txt" }],
      }),
    ]);
  });
});
