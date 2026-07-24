/**
 * @vitest-environment jsdom
 *
 * Drives the imperative activity-signal capture controller against a mocked
 * ElizaClient + native bridges in a real jsdom browser environment across all
 * three device shapes (web, desktop/Electrobun, native mobile). Proves it
 * posts presence once the runtime reports running, re-emits on
 * lifecycle/visibility events, dedupes rapid repeats, maps native mobile
 * snapshots, degrades quietly on runtime-unavailable/network errors, surfaces
 * unexpected failures observably, is idempotent across repeated starts,
 * enforces the permission consent gate, survives stop() racing any awaited
 * native operation without leaking handles/monitors/intervals, and fully
 * tears down its listeners/intervals on stop.
 *
 * `@elizaos/ui/api`, `/bridge`, `/browser`, and `/events` all alias to the
 * same stub file under this package's vitest config, so a single complete mock
 * factory is shared across the four specifiers — otherwise the last `vi.mock`
 * wins and drops exports the earlier specifiers need (e.g. isElectrobunRuntime).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const mobile = {
    listenerCb: null as null | ((signal: unknown) => void),
    listenerRemoves: [] as Array<ReturnType<typeof vi.fn>>,
    checkPermissions: vi.fn(async () => ({ status: "granted" })),
    addListener: vi.fn(
      async (_event: string, cb: (signal: unknown) => void) => {
        mobile.listenerCb = cb;
        const remove = vi.fn(async () => {});
        mobile.listenerRemoves.push(remove);
        return { remove };
      },
    ),
    releaseSignalListeners: vi.fn(async () => ({ removed: true })),
    startMonitoring: vi.fn(async () => ({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    })),
    stopMonitoring: vi.fn(async () => ({ stopped: true })),
    getSnapshot: vi.fn(async () => ({
      supported: false,
      snapshot: null,
      healthSnapshot: null,
    })),
    scheduleBackgroundRefresh: vi.fn(async () => ({ scheduled: true })),
    cancelBackgroundRefresh: vi.fn(async () => ({ cancelled: true })),
  };
  return {
    // The client-lifeops / client-calendar extension modules (side-effect
    // imports of the capture) install methods onto ElizaClient.prototype at
    // module scope; give the mock a real class so those installs land.
    ElizaClient: class ElizaClient {},
    getStatus: vi.fn(async () => ({ state: "running" })),
    captureLifeOpsActivitySignal: vi.fn(async () => ({
      signal: { id: "sig-1" },
    })),
    isApiError: vi.fn((_error: unknown) => false),
    isElectrobunRuntime: vi.fn(() => false),
    loadDesktopWorkspaceSnapshot: vi.fn(async () => ({ supported: false })),
    dispatchStatus: vi.fn(),
    capacitorGetPlatform: vi.fn(() => "web"),
    capacitorIsNative: vi.fn(() => false),
    mobile,
  };
});

// The four @elizaos/ui subpath specifiers (/api, /bridge, /browser, /events)
// all alias to the same stub file under this package's vitest config, so each
// mock returns the same combined shape: client + isApiError + ElizaClient
// (/api), isElectrobunRuntime (/bridge), loadDesktopWorkspaceSnapshot
// (/browser), lifecycle event names (/events). The object literal is inlined
// per call and reads only the hoisted `h` — any module-scope const would sit
// in its TDZ when the hoisted `vi.mock` and source import run.
vi.mock("@elizaos/ui/api", () => ({
  isApiError: h.isApiError,
  ElizaClient: h.ElizaClient,
  isElectrobunRuntime: h.isElectrobunRuntime,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));
vi.mock("@elizaos/ui/bridge", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
}));
vi.mock("@elizaos/ui/events", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
}));
vi.mock("@elizaos/ui/browser", () => ({
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  ElizaClient: h.ElizaClient,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: h.capacitorGetPlatform,
    isNativePlatform: h.capacitorIsNative,
  },
}));

vi.mock("@elizaos/capacitor-mobile-signals", () => ({
  MobileSignals: h.mobile,
}));

vi.mock("../events/index.js", () => ({
  dispatchLifeOpsActivitySignalsStatus: h.dispatchStatus,
}));

import {
  isLifeOpsActivitySignalCaptureActive,
  startLifeOpsActivitySignalCapture,
} from "./activity-signals-capture.js";

const DEVICE_SNAPSHOT = {
  source: "mobile_device",
  platform: "ios",
  state: "active",
  observedAt: 1_700_000_000_000,
  idleState: "active",
  idleTimeSeconds: 12,
  onBattery: true,
  metadata: { app: "com.example" },
};

const HEALTH_SNAPSHOT = {
  source: "mobile_health",
  platform: "ios",
  state: "sleeping",
  observedAt: 1_700_000_100_000,
  idleState: "idle",
  idleTimeSeconds: null,
  onBattery: null,
  healthSource: "healthkit",
  permissions: { sleep: true, biometrics: true },
  sleep: {
    available: true,
    isSleeping: true,
    asleepAt: 1_699_999_000_000,
    awakeAt: null,
    durationMinutes: 420,
    stage: "core",
  },
  biometrics: {
    sampleAt: 1_700_000_050_000,
    heartRateBpm: 58,
    restingHeartRateBpm: 54,
    heartRateVariabilityMs: 42,
    respiratoryRate: 14,
    bloodOxygenPercent: 98,
  },
  warnings: ["battery low"],
  metadata: { note: "overnight" },
  screenTime: { supported: false, reason: null },
};

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function capturedSources(): string[] {
  return h.captureLifeOpsActivitySignal.mock.calls.map(
    ([signal]) => (signal as { source: string }).source,
  );
}

function mockNativeMobile(): void {
  h.capacitorIsNative.mockReturnValue(true);
  h.capacitorGetPlatform.mockReturnValue("ios");
}

describe("startLifeOpsActivitySignalCapture", () => {
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    h.getStatus.mockResolvedValue({ state: "running" });
    h.captureLifeOpsActivitySignal.mockResolvedValue({
      signal: { id: "sig-1" },
    });
    h.isApiError.mockReturnValue(false);
    h.isElectrobunRuntime.mockReturnValue(false);
    h.loadDesktopWorkspaceSnapshot.mockResolvedValue({ supported: false });
    h.capacitorGetPlatform.mockReturnValue("web");
    h.capacitorIsNative.mockReturnValue(false);
    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });
    h.mobile.addListener.mockImplementation(
      async (_event: string, cb: (signal: unknown) => void) => {
        h.mobile.listenerCb = cb;
        const remove = vi.fn(async () => {});
        h.mobile.listenerRemoves.push(remove);
        return { remove };
      },
    );
    h.mobile.getSnapshot.mockResolvedValue({
      supported: false,
      snapshot: null,
      healthSnapshot: null,
    });
    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    h.mobile.stopMonitoring.mockResolvedValue({ stopped: true });
    h.mobile.releaseSignalListeners.mockResolvedValue({ removed: true });
    h.mobile.scheduleBackgroundRefresh.mockResolvedValue({ scheduled: true });
    h.mobile.cancelBackgroundRefresh.mockResolvedValue({ cancelled: true });
    h.mobile.listenerCb = null;
    h.mobile.listenerRemoves.length = 0;
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    vi.useRealTimers();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
  });

  it("returns a no-op when disabled and captures nothing", async () => {
    stop = startLifeOpsActivitySignalCapture(false);
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    await expect(stop()).resolves.toBeUndefined();
    stop = undefined;
  });

  it("posts the current web presence once the runtime reports running", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.getStatus).toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    const sources = capturedSources();
    expect(sources).toContain("app_lifecycle");
    expect(sources).toContain("page_visibility");
    for (const [signal] of h.captureLifeOpsActivitySignal.mock.calls) {
      expect((signal as { platform?: string }).platform).toBe("web_app");
    }
  });

  it("is idempotent: a second start returns the active stop without duplicating work", async () => {
    const addDoc = vi.spyOn(document, "addEventListener");
    stop = startLifeOpsActivitySignalCapture(true);
    const listenerInstalls = addDoc.mock.calls.length;

    const second = startLifeOpsActivitySignalCapture(true);
    expect(second).toBe(stop);
    // No additional listeners were installed by the duplicate start.
    expect(addDoc.mock.calls.length).toBe(listenerInstalls);
    expect(h.getStatus).toHaveBeenCalledTimes(1);
    addDoc.mockRestore();
  });

  it("re-initializes cleanly after stop (stop → start → new capture)", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    await stop();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);

    stop = startLifeOpsActivitySignalCapture(true);
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    await settle();
    // The restarted capture probes the runtime again.
    expect(h.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("re-emits presence on visibility, focus, blur, resume and pause", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    h.captureLifeOpsActivitySignal.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("eliza:app-resume"));
    document.dispatchEvent(new Event("eliza:app-pause"));
    await settle();

    const sources = capturedSources();
    expect(
      sources.filter((s) => s === "page_visibility").length,
    ).toBeGreaterThan(0);
    // resume/pause both push an app_lifecycle presence signal.
    expect(sources).toContain("app_lifecycle");
  });

  it("stands down when the runtime is not running", async () => {
    h.getStatus.mockResolvedValue({ state: "stopped" });
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.getStatus).toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
  });

  it("emits the current state once the runtime becomes ready on a later poll", async () => {
    vi.useFakeTimers();
    h.getStatus.mockResolvedValueOnce({ state: "stopped" });
    h.getStatus.mockResolvedValue({ state: "running" });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();

    // The 5s runtime-ready poller flips ready and emits the initial burst.
    await vi.advanceTimersByTimeAsync(5_000);
    const sources = capturedSources();
    expect(sources).toContain("app_lifecycle");
    expect(sources).toContain("page_visibility");
  });

  it("dedupes identical presence signals inside the dedup window", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    h.captureLifeOpsActivitySignal.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    const visibilityPosts = h.captureLifeOpsActivitySignal.mock.calls.filter(
      ([signal]) => (signal as { source: string }).source === "page_visibility",
    );
    expect(visibilityPosts.length).toBe(1);
  });

  it("captures a desktop power snapshot on the Electrobun runtime", async () => {
    h.isElectrobunRuntime.mockReturnValue(true);
    h.loadDesktopWorkspaceSnapshot.mockResolvedValue({
      supported: true,
      power: { idleState: "active", idleTime: 3.7, onBattery: false },
      window: { focused: true, visible: true },
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    const desktopCalls = h.captureLifeOpsActivitySignal.mock.calls.filter(
      ([signal]) => (signal as { source: string }).source === "desktop_power",
    );
    expect(desktopCalls.length).toBeGreaterThan(0);
    const [desktopSignal] = desktopCalls[0] as [
      { platform?: string; state: string; idleTimeSeconds?: number },
    ];
    expect(desktopSignal.platform).toBe("desktop_app");
    expect(desktopSignal.state).toBe("active");
    expect(desktopSignal.idleTimeSeconds).toBe(3);
  });

  it("does not let a wedged desktop probe pin teardown or accumulate polls", async () => {
    h.isElectrobunRuntime.mockReturnValue(true);
    let releaseWedgedProbe:
      | ((snapshot: {
          supported: true;
          power: {
            idleState: "active";
            idleTime: number;
            onBattery: boolean;
          };
          window: { focused: boolean; visible: boolean };
        }) => void)
      | undefined;
    h.loadDesktopWorkspaceSnapshot
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseWedgedProbe = resolve;
          }),
      )
      .mockResolvedValue({ supported: false });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() =>
      expect(h.loadDesktopWorkspaceSnapshot).toHaveBeenCalledTimes(1),
    );
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("eliza:app-resume"));
    expect(h.loadDesktopWorkspaceSnapshot).toHaveBeenCalledTimes(1);

    const firstStop = stop;
    stop = undefined;
    await expect(firstStop()).resolves.toBeUndefined();

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() =>
      expect(h.loadDesktopWorkspaceSnapshot).toHaveBeenCalledTimes(2),
    );
    h.captureLifeOpsActivitySignal.mockClear();
    releaseWedgedProbe?.({
      supported: true,
      power: { idleState: "active", idleTime: 1, onBattery: false },
      window: { focused: true, visible: true },
    });
    await settle();

    expect(capturedSources()).not.toContain("desktop_power");
  });

  it("keeps one unbounded runtime probe and lets teardown replace it", async () => {
    vi.useFakeTimers();
    let releaseWedgedProbe:
      | ((status: { state: "running" }) => void)
      | undefined;
    h.getStatus
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseWedgedProbe = resolve;
          }),
      )
      .mockResolvedValue({ state: "running" });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.getStatus).toHaveBeenCalledTimes(1);

    const firstStop = stop;
    stop = undefined;
    await expect(firstStop()).resolves.toBeUndefined();

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.getStatus).toHaveBeenCalledTimes(2);
    expect(capturedSources()).toContain("app_lifecycle");

    h.captureLifeOpsActivitySignal.mockClear();
    releaseWedgedProbe?.({ state: "running" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
  });

  it("captures and maps native mobile device + health snapshots", async () => {
    mockNativeMobile();
    h.mobile.getSnapshot.mockResolvedValue({
      supported: true,
      snapshot: DEVICE_SNAPSHOT,
      healthSnapshot: HEALTH_SNAPSHOT,
    });
    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: DEVICE_SNAPSHOT,
      healthSnapshot: HEALTH_SNAPSHOT,
    });
    h.mobile.scheduleBackgroundRefresh.mockResolvedValue({
      scheduled: false,
      reason: "os_denied",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.checkPermissions).toHaveBeenCalled();
    expect(h.mobile.startMonitoring).toHaveBeenCalledWith({
      emitInitial: true,
    });

    const sources = capturedSources();
    expect(sources).toContain("mobile_device");
    expect(sources).toContain("mobile_health");

    // The health snapshot is mapped to the capture DTO shape with ISO dates.
    const [healthSignal] = (h.captureLifeOpsActivitySignal.mock.calls.find(
      ([signal]) => (signal as { source: string }).source === "mobile_health",
    ) ?? []) as [
      {
        platform?: string;
        health?: { sleep: { asleepAt: string | null; awakeAt: string | null } };
        metadata?: Record<string, unknown>;
      },
    ];
    expect(healthSignal.platform).toBe("ios");
    expect(healthSignal.health?.sleep.asleepAt).toBe(
      new Date(HEALTH_SNAPSHOT.sleep.asleepAt).toISOString(),
    );
    expect(healthSignal.health?.sleep.awakeAt).toBeNull();
    expect(healthSignal.metadata).toMatchObject({
      screenTime: expect.any(Object),
    });

    // A background-refresh denial surfaces as a status event.
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "background_refresh_unavailable" }),
    );

    // The signal listener drives further captures.
    expect(h.mobile.listenerCb).toBeTypeOf("function");
    h.mobile.listenerCb?.({
      ...DEVICE_SNAPSHOT,
      state: "idle",
      metadata: { app: "x" },
    });
    await settle();
    expect(
      capturedSources().filter((s) => s === "mobile_device").length,
    ).toBeGreaterThan(1);

    await stop();
    stop = undefined;
    expect(h.mobile.stopMonitoring).toHaveBeenCalled();
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalled();
  });

  it("refuses to schedule background work when the bridge cannot cancel it", async () => {
    mockNativeMobile();
    const cancelBackgroundRefresh = h.mobile.cancelBackgroundRefresh;
    h.mobile.cancelBackgroundRefresh = undefined as never;

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    h.mobile.cancelBackgroundRefresh = cancelBackgroundRefresh;

    expect(h.mobile.scheduleBackgroundRefresh).not.toHaveBeenCalled();
    expect(h.dispatchStatus).toHaveBeenCalledWith({
      status: "background_refresh_unavailable",
      reason: "cancel_unavailable",
    });

    await stop();
    stop = undefined;
  });

  it("rolls back a rejected native start and retries cleanly on resume", async () => {
    mockNativeMobile();
    h.mobile.addListener
      .mockResolvedValueOnce({ remove: vi.fn(async () => {}) })
      .mockResolvedValueOnce({ remove: vi.fn(async () => {}) });
    h.mobile.startMonitoring
      .mockRejectedValueOnce(new Error("native start rejected"))
      .mockResolvedValueOnce({
        enabled: true,
        supported: true,
        platform: "ios",
        snapshot: null,
        healthSnapshot: null,
      });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(1);
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1);
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(h.mobile.addListener).toHaveBeenCalledTimes(2);
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(1);
  });

  it("rolls back a disabled native start instead of wedging future retries", async () => {
    mockNativeMobile();
    h.mobile.addListener
      .mockResolvedValueOnce({ remove: vi.fn(async () => {}) })
      .mockResolvedValueOnce({ remove: vi.fn(async () => {}) });
    h.mobile.startMonitoring
      .mockResolvedValueOnce({
        enabled: false,
        supported: true,
        platform: "ios",
        snapshot: null,
        healthSnapshot: null,
      })
      .mockResolvedValueOnce({
        enabled: true,
        supported: true,
        platform: "ios",
        snapshot: null,
        healthSnapshot: null,
      });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
  });

  it("keeps the generation active until asynchronous native teardown settles", async () => {
    mockNativeMobile();
    let releaseStop: (() => void) | undefined;
    h.mobile.stopMonitoring.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStop = () => resolve({ stopped: true });
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    const stopping = stop();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    expect(startLifeOpsActivitySignalCapture(true)).toBe(stop);

    await vi.waitFor(() => expect(releaseStop).toBeTypeOf("function"));
    releaseStop?.();
    await stopping;
    stop = undefined;
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
  });

  it("publishes cleanup ownership before a native release can re-enter stop", async () => {
    mockNativeMobile();
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    let reenteredStop: Promise<void> | undefined;
    h.mobile.releaseSignalListeners.mockImplementation(() => {
      reenteredStop = stop?.();
      return Promise.resolve({ removed: true });
    });

    const firstStop = stop();
    expect(reenteredStop).toBe(firstStop);
    await firstStop;
    stop = undefined;

    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(1);
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1);
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalledTimes(1);
  });

  it("queues native release immediately while an owned snapshot read is pending", async () => {
    mockNativeMobile();
    const finishSnapshots: Array<
      (result: {
        supported: boolean;
        snapshot: null;
        healthSnapshot: null;
      }) => void
    > = [];
    h.mobile.getSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSnapshots.push(resolve);
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() => expect(finishSnapshots.length).toBeGreaterThan(0));

    const stopping = stop();
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1);
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalledTimes(1);

    for (const finishSnapshot of finishSnapshots) {
      finishSnapshot({
        supported: false,
        snapshot: null,
        healthSnapshot: null,
      });
    }
    await stopping;
    stop = undefined;
  });

  it("does not start deferred native reads or scheduling after teardown begins during initial persistence", async () => {
    mockNativeMobile();
    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: DEVICE_SNAPSHOT,
      healthSnapshot: null,
    });

    let stopping: Promise<void> | undefined;
    h.captureLifeOpsActivitySignal.mockImplementation(
      (
        signal: { source: string },
        options?: {
          signal?: AbortSignal;
        },
      ) => {
        if (signal.source !== "mobile_device") {
          return Promise.resolve({ signal: { id: "sig-1" } });
        }
        return new Promise((_resolve, reject) => {
          const uploadSignal = options?.signal;
          if (!uploadSignal) {
            reject(new Error("missing capture AbortSignal"));
            return;
          }
          uploadSignal.addEventListener(
            "abort",
            () => reject(new DOMException("stopped", "AbortError")),
            { once: true },
          );
          const cleanup = stop;
          if (!cleanup) {
            reject(new Error("capture teardown was not installed"));
            return;
          }
          stopping = cleanup();
          stop = undefined;
        });
      },
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() => expect(stopping).toBeDefined());
    await stopping;

    // Native snapshots are consent-gated and the startup enrichment observes
    // the synchronous teardown before it can create fresh bridge work.
    expect(h.mobile.getSnapshot).not.toHaveBeenCalled();
    expect(h.mobile.scheduleBackgroundRefresh).not.toHaveBeenCalled();
    expect(h.mobile.stopMonitoring).toHaveBeenCalled();
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalled();
  });

  it("keeps scheduling and health retries alive when initial persistence fails", async () => {
    mockNativeMobile();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({ kind: "network" });
    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: DEVICE_SNAPSHOT,
      healthSnapshot: HEALTH_SNAPSHOT,
    });
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.scheduleBackgroundRefresh).toHaveBeenCalledTimes(1);
    expect(
      setIntervalSpy.mock.calls.some(([, delay]) => delay === 5 * 60_000),
    ).toBe(true);
    expect(h.mobile.listenerCb).toBeTypeOf("function");
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
    expect(consoleError).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    consoleError.mockRestore();
  });

  it("aborts and settles owned signal uploads before teardown completes", async () => {
    const observedSignals: AbortSignal[] = [];
    h.captureLifeOpsActivitySignal.mockImplementation(
      (
        _signal: unknown,
        options?: {
          signal?: AbortSignal;
        },
      ) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("missing capture AbortSignal"));
            return;
          }
          observedSignals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("stopped", "AbortError")),
            { once: true },
          );
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle(2);
    expect(observedSignals.length).toBeGreaterThan(0);

    await stop();
    stop = undefined;

    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("waits for late background scheduling and then cancels the accepted job", async () => {
    mockNativeMobile();
    const events: string[] = [];
    let finishSchedule:
      | ((result: { scheduled: boolean; reason?: string }) => void)
      | undefined;
    h.mobile.scheduleBackgroundRefresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          events.push("schedule:start");
          finishSchedule = (result) => {
            events.push("schedule:end");
            resolve(result);
          };
        }),
    );
    h.mobile.cancelBackgroundRefresh.mockImplementation(async () => {
      events.push("cancel");
      return { cancelled: true };
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() => expect(finishSchedule).toBeTypeOf("function"));
    const stopping = stop();
    expect(events).toEqual(["schedule:start", "cancel"]);

    finishSchedule?.({ scheduled: true });
    await stopping;
    stop = undefined;

    expect(events).toEqual([
      "schedule:start",
      "cancel",
      "schedule:end",
      "cancel",
    ]);
  });

  it("retains failed native ownership and retries every incomplete release", async () => {
    mockNativeMobile();
    h.mobile.releaseSignalListeners.mockRejectedValue(
      new Error("listener registry release failed"),
    );
    h.mobile.stopMonitoring.mockRejectedValue(new Error("monitor stop failed"));

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    const cleanup = stop;
    stop = undefined;
    await expect(cleanup()).rejects.toThrow(
      "Failed to stop LifeOps native activity capture after the late-acquisition sweep",
    );

    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(2);
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(2);
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalledTimes(1);
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    expect(startLifeOpsActivitySignalCapture(true)).toBe(cleanup);

    h.mobile.releaseSignalListeners.mockResolvedValue({ removed: true });
    h.mobile.stopMonitoring.mockResolvedValue({ stopped: true });
    await cleanup();

    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(3);
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(3);
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
  });

  it("treats fulfilled false release results as retained ownership", async () => {
    mockNativeMobile();
    h.mobile.releaseSignalListeners.mockResolvedValue({ removed: false });
    h.mobile.stopMonitoring.mockResolvedValue({ stopped: false });
    h.mobile.cancelBackgroundRefresh.mockResolvedValue({
      cancelled: false,
      reason: "native owner still active",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    const cleanup = stop;
    stop = undefined;
    await expect(cleanup()).rejects.toThrow(
      "Failed to stop LifeOps native activity capture after the late-acquisition sweep",
    );
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);

    h.mobile.releaseSignalListeners.mockResolvedValue({ removed: true });
    h.mobile.stopMonitoring.mockResolvedValue({ stopped: true });
    h.mobile.cancelBackgroundRefresh.mockResolvedValue({ cancelled: true });
    await cleanup();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
  });

  it("never starts native monitoring without granted permission (consent gate)", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockResolvedValue({ status: "denied" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.checkPermissions).toHaveBeenCalled();
    expect(h.mobile.addListener).not.toHaveBeenCalled();
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();
    expect(h.mobile.getSnapshot).not.toHaveBeenCalled();
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "permission_unavailable",
        reason: "denied",
      }),
    );

    document.dispatchEvent(new Event("eliza:app-pause"));
    await settle();
    expect(h.mobile.getSnapshot).not.toHaveBeenCalled();
  });

  it("does not prompt for permission when consent is not yet determined", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockResolvedValue({ status: "not-determined" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();
    expect(h.mobile.getSnapshot).not.toHaveBeenCalled();
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "permission_unavailable",
        reason: "not-determined",
      }),
    );
  });

  it("starts on iOS once the privacy-preserving HealthKit decision is determined", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockResolvedValue({
      status: "determined",
      permissions: { sleep: false, biometrics: false },
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.addListener).toHaveBeenCalledTimes(1);
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
  });

  it("picks up a permission granted later on app resume", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockResolvedValueOnce({ status: "denied" });
    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();

    // The user grants consent in OS Settings and returns to the app.
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
  });

  it("stops committed monitoring when consent is revoked before a resume read", async () => {
    mockNativeMobile();

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
    const snapshotsBeforeResume = h.mobile.getSnapshot.mock.calls.length;

    h.mobile.checkPermissions.mockResolvedValue({ status: "denied" });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1);
    expect(h.mobile.getSnapshot).toHaveBeenCalledTimes(snapshotsBeforeResume);
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "permission_unavailable",
        reason: "denied",
      }),
    );

    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
  });

  it("clears the health poller across revocation and installs only one replacement after re-grant", async () => {
    mockNativeMobile();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    const healthIntervalIndexes = (): number[] =>
      setIntervalSpy.mock.calls.flatMap(([, delay], index) =>
        delay === 5 * 60_000 ? [index] : [],
      );
    expect(healthIntervalIndexes()).toHaveLength(1);
    const firstHealthInterval =
      setIntervalSpy.mock.results[healthIntervalIndexes()[0]]?.value;

    h.mobile.checkPermissions.mockResolvedValue({ status: "denied" });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(clearIntervalSpy).toHaveBeenCalledWith(firstHealthInterval);
    const readsAfterRevocation = h.mobile.getSnapshot.mock.calls.length;
    document.dispatchEvent(new Event("eliza:app-pause"));
    await settle();
    expect(h.mobile.getSnapshot).toHaveBeenCalledTimes(readsAfterRevocation);

    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(healthIntervalIndexes()).toHaveLength(2);
    const secondHealthInterval =
      setIntervalSpy.mock.results[healthIntervalIndexes()[1]]?.value;
    expect(secondHealthInterval).not.toBe(firstHealthInterval);

    await stop();
    stop = undefined;
    expect(clearIntervalSpy).toHaveBeenCalledWith(secondHealthInterval);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("releases residual ownership and starts a fresh listener after partial revocation teardown", async () => {
    mockNativeMobile();

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.addListener).toHaveBeenCalledTimes(1);
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    h.mobile.stopMonitoring.mockResolvedValueOnce({ stopped: false });
    h.mobile.checkPermissions.mockResolvedValue({ status: "denied" });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(1);
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1);
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );

    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    // The failed stop is retried before a successor acquires a fresh listener.
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(2);
    expect(h.mobile.addListener).toHaveBeenCalledTimes(2);
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
  });

  it("fences delayed reads and callbacks from a released consent generation", async () => {
    mockNativeMobile();
    let finishOldRead:
      | ((result: {
          supported: boolean;
          snapshot: typeof DEVICE_SNAPSHOT;
          healthSnapshot: typeof HEALTH_SNAPSHOT;
        }) => void)
      | undefined;
    h.mobile.getSnapshot
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRead = resolve;
          }),
      )
      .mockResolvedValue({
        supported: false,
        snapshot: null,
        healthSnapshot: null,
      });
    h.mobile.checkPermissions
      .mockResolvedValueOnce({ status: "granted" })
      .mockResolvedValueOnce({ status: "denied" })
      .mockResolvedValue({ status: "granted" });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() => expect(finishOldRead).toBeTypeOf("function"));
    await vi.waitFor(() => expect(h.mobile.listenerCb).toBeTypeOf("function"));
    const releasedGenerationCallback = h.mobile.listenerCb;
    h.captureLifeOpsActivitySignal.mockClear();

    document.dispatchEvent(new Event("eliza:app-resume"));
    await vi.waitFor(() =>
      expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1),
    );
    releasedGenerationCallback?.({
      ...DEVICE_SNAPSHOT,
      metadata: { generation: "released-before-settle" },
    });
    finishOldRead?.({
      supported: true,
      snapshot: {
        ...DEVICE_SNAPSHOT,
        metadata: { generation: "released-read" },
      },
      healthSnapshot: HEALTH_SNAPSHOT,
    });
    await settle();

    const releasedGenerationSignals =
      h.captureLifeOpsActivitySignal.mock.calls.filter(([signal]) =>
        (signal as { source: string }).source.startsWith("mobile_"),
      );
    expect(releasedGenerationSignals).toHaveLength(0);

    document.dispatchEvent(new Event("eliza:app-resume"));
    await vi.waitFor(() =>
      expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2),
    );
    const currentGenerationCallback = h.mobile.listenerCb;
    expect(currentGenerationCallback).not.toBe(releasedGenerationCallback);

    releasedGenerationCallback?.({
      ...DEVICE_SNAPSHOT,
      metadata: { generation: "released-after-restart" },
    });
    currentGenerationCallback?.({
      ...DEVICE_SNAPSHOT,
      metadata: { generation: "current" },
    });
    await settle();

    const callbackGenerations =
      h.captureLifeOpsActivitySignal.mock.calls.flatMap(([signal]) => {
        const metadata = (signal as { metadata?: { generation?: string } })
          .metadata;
        return metadata?.generation ? [metadata.generation] : [];
      });
    expect(callbackGenerations).toContain("current");
    expect(callbackGenerations).not.toContain("released-read");
    expect(callbackGenerations).not.toContain("released-before-settle");
    expect(callbackGenerations).not.toContain("released-after-restart");
  });

  it("aborts and settles a released generation upload before allowing restart", async () => {
    mockNativeMobile();
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    const releasedGenerationCallback = h.mobile.listenerCb;
    expect(releasedGenerationCallback).toBeTypeOf("function");

    let finishUpload:
      | ((result: { signal: { id: string } }) => void)
      | undefined;
    let uploadSignal: AbortSignal | undefined;
    h.captureLifeOpsActivitySignal.mockImplementation(
      (
        signal: { metadata?: { generation?: string } },
        options?: { signal?: AbortSignal },
      ) => {
        if (signal.metadata?.generation !== "pending") {
          return Promise.resolve({ signal: { id: "sig-1" } });
        }
        uploadSignal = options?.signal;
        return new Promise((resolve) => {
          finishUpload = resolve;
        });
      },
    );

    releasedGenerationCallback?.({
      ...DEVICE_SNAPSHOT,
      metadata: { generation: "pending" },
    });
    await vi.waitFor(() => expect(finishUpload).toBeTypeOf("function"));

    h.mobile.checkPermissions
      .mockResolvedValueOnce({ status: "denied" })
      .mockResolvedValue({ status: "granted" });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await vi.waitFor(() => expect(uploadSignal?.aborted).toBe(true));

    // A later resume records a stronger consent epoch, but cannot acquire its
    // successor while the old transport still owns an unsettled operation.
    document.dispatchEvent(new Event("eliza:app-resume"));
    await Promise.resolve();
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    finishUpload?.({ signal: { id: "late-old-generation" } });
    await vi.waitFor(() =>
      expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2),
    );
  });

  it("does not let an older failed upload erase a newer dedupe entry", async () => {
    mockNativeMobile();
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    const callback = h.mobile.listenerCb;
    expect(callback).toBeTypeOf("function");

    let failOlderUpload: ((reason?: unknown) => void) | undefined;
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockImplementation(
      (signal: { metadata?: { sequence?: string } }) => {
        if (signal.metadata?.sequence === "older") {
          return new Promise((_resolve, reject) => {
            failOlderUpload = reject;
          });
        }
        return Promise.resolve({ signal: { id: "sig-newer" } });
      },
    );

    callback?.({
      ...DEVICE_SNAPSHOT,
      metadata: { sequence: "older" },
    });
    callback?.({
      ...DEVICE_SNAPSHOT,
      metadata: { sequence: "newer" },
    });
    await vi.waitFor(() => expect(failOlderUpload).toBeTypeOf("function"));
    await vi.waitFor(() =>
      expect(
        h.captureLifeOpsActivitySignal.mock.calls.filter(
          ([signal]) =>
            (signal as { metadata?: { sequence?: string } }).metadata
              ?.sequence === "newer",
        ),
      ).toHaveLength(1),
    );

    failOlderUpload?.({ kind: "network" });
    await settle();
    callback?.({
      ...DEVICE_SNAPSHOT,
      metadata: { sequence: "newer" },
    });
    await settle();

    expect(
      h.captureLifeOpsActivitySignal.mock.calls.filter(
        ([signal]) =>
          (signal as { metadata?: { sequence?: string } }).metadata
            ?.sequence === "newer",
      ),
    ).toHaveLength(1);
  });

  it("revalidates denied consent even while post-commit enrichment is hung", async () => {
    mockNativeMobile();
    let finishSnapshot:
      | ((result: {
          supported: boolean;
          snapshot: null;
          healthSnapshot: null;
        }) => void)
      | undefined;
    h.mobile.getSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSnapshot = resolve;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() => expect(finishSnapshot).toBeTypeOf("function"));
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    h.mobile.checkPermissions.mockResolvedValue({ status: "denied" });
    document.dispatchEvent(new Event("eliza:app-resume"));

    await vi.waitFor(() =>
      expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(h.mobile.stopMonitoring).toHaveBeenCalled());

    finishSnapshot?.({
      supported: false,
      snapshot: null,
      healthSnapshot: null,
    });
    await settle();
  });

  it("queues resume consent revalidation while initial native acquisition is pending", async () => {
    mockNativeMobile();
    let resolveInitialPermission:
      | ((result: { status: string }) => void)
      | undefined;
    h.mobile.checkPermissions
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialPermission = resolve;
          }),
      )
      .mockResolvedValueOnce({ status: "denied" });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() =>
      expect(resolveInitialPermission).toBeTypeOf("function"),
    );

    document.dispatchEvent(new Event("eliza:app-resume"));
    resolveInitialPermission?.({ status: "granted" });

    await vi.waitFor(() =>
      expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() =>
      expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1),
    );
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "permission_unavailable",
        reason: "denied",
      }),
    );
  });

  it("stopping during an awaited listener registration clears the native registry", async () => {
    mockNativeMobile();
    const remove = vi.fn(async () => {});
    let releaseAddListener:
      | ((handle: { remove: typeof remove }) => void)
      | undefined;
    h.mobile.addListener.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAddListener = resolve;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.addListener).toHaveBeenCalled();

    const stopping = stop();
    stop = undefined;
    releaseAddListener?.({ remove });
    await stopping;
    await settle();

    // The resolved handle queues Capacitor's ordinary removeListener call,
    // while the package-owned release proves both native registries empty.
    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();
  });

  it("releases every saved listener callback across repeated generations", async () => {
    mockNativeMobile();

    for (let generation = 0; generation < 3; generation += 1) {
      stop = startLifeOpsActivitySignalCapture(true);
      await settle();
      const cleanup = stop;
      stop = undefined;
      await cleanup();
    }

    expect(h.mobile.addListener).toHaveBeenCalledTimes(3);
    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(3);
    expect(h.mobile.listenerRemoves).toHaveLength(3);
    for (const remove of h.mobile.listenerRemoves) {
      expect(remove).toHaveBeenCalledTimes(1);
    }
  });

  it("does not let a stale generic listener handle block authoritative release", async () => {
    mockNativeMobile();
    const remove = vi.fn(() => new Promise<void>(() => {}));
    h.mobile.addListener.mockResolvedValue({ remove });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    const cleanup = stop;
    stop = undefined;

    await expect(cleanup()).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(h.mobile.releaseSignalListeners).toHaveBeenCalledTimes(1);
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
  });

  it("stopping during an awaited startMonitoring stops the monitor and installs no late interval", async () => {
    mockNativeMobile();
    let releaseStartMonitoring:
      | ((result: {
          enabled: boolean;
          supported: boolean;
          platform: string;
          snapshot: null;
          healthSnapshot: null;
        }) => void)
      | undefined;
    h.mobile.startMonitoring.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStartMonitoring = resolve;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.startMonitoring).toHaveBeenCalled();

    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const stopping = stop();
    stop = undefined;
    releaseStartMonitoring?.({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    await stopping;
    await settle();

    // The monitor that engaged after stop is stood down, and the five-minute
    // health poller is never installed.
    expect(h.mobile.stopMonitoring).toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it("coalesces concurrent resumes into one revalidation without double-starting", async () => {
    mockNativeMobile();
    const permissionResolvers: Array<(status: { status: string }) => void> = [];
    h.mobile.checkPermissions.mockImplementation(
      () =>
        new Promise((resolve) => {
          permissionResolvers.push(resolve);
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() => expect(permissionResolvers).toHaveLength(1));
    expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(1);

    // Resume requires a fresh consent read, but simultaneous resume events
    // coalesce behind one stronger follow-up check.
    document.dispatchEvent(new Event("eliza:app-resume"));
    document.dispatchEvent(new Event("eliza:app-resume"));
    permissionResolvers.shift()?.({ status: "granted" });
    await vi.waitFor(() => expect(permissionResolvers).toHaveLength(1));
    permissionResolvers.shift()?.({ status: "granted" });
    await vi.waitFor(() =>
      expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(2),
    );

    expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(2);
    expect(h.mobile.addListener).toHaveBeenCalledTimes(1);
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
  });

  it("publishes acquisition ownership before a permission check can re-enter resume", async () => {
    mockNativeMobile();
    let releaseInitialPermission:
      | ((status: { status: "granted" }) => void)
      | undefined;
    h.mobile.checkPermissions
      .mockImplementationOnce(() => {
        document.dispatchEvent(new Event("eliza:app-resume"));
        return new Promise((resolve) => {
          releaseInitialPermission = resolve;
        });
      })
      .mockResolvedValue({ status: "granted" });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() =>
      expect(releaseInitialPermission).toBeTypeOf("function"),
    );

    expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(1);
    expect(h.mobile.addListener).not.toHaveBeenCalled();
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();

    releaseInitialPermission?.({ status: "granted" });
    await vi.waitFor(() =>
      expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() =>
      expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1),
    );
    expect(h.mobile.addListener).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent resume health refreshes into one native read", async () => {
    mockNativeMobile();
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    h.mobile.checkPermissions.mockClear();
    h.mobile.getSnapshot.mockClear();

    const finishPermissions: Array<(status: { status: string }) => void> = [];
    h.mobile.checkPermissions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPermissions.push(resolve);
        }),
    );

    document.dispatchEvent(new Event("eliza:app-resume"));
    document.dispatchEvent(new Event("eliza:app-resume"));
    await vi.waitFor(() => expect(finishPermissions).toHaveLength(1));
    finishPermissions.shift()?.({ status: "granted" });
    await vi.waitFor(() => expect(finishPermissions).toHaveLength(1));
    finishPermissions.shift()?.({ status: "granted" });
    await vi.waitFor(() =>
      expect(h.mobile.getSnapshot).toHaveBeenCalledTimes(1),
    );
    await settle();

    // Both resume epochs are revalidated, but their shared completion schedules
    // one health read rather than one read per caller.
    expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(2);
    expect(h.mobile.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("publishes health-read ownership before getSnapshot can re-enter pause", async () => {
    mockNativeMobile();
    let releaseSnapshot:
      | ((result: {
          supported: false;
          snapshot: null;
          healthSnapshot: null;
        }) => void)
      | undefined;
    h.mobile.getSnapshot.mockImplementation(() => {
      document.dispatchEvent(new Event("eliza:app-pause"));
      return new Promise((resolve) => {
        releaseSnapshot = resolve;
      });
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.waitFor(() => expect(releaseSnapshot).toBeTypeOf("function"));

    expect(h.mobile.getSnapshot).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("eliza:app-pause"));
    expect(h.mobile.getSnapshot).toHaveBeenCalledTimes(1);

    releaseSnapshot?.({
      supported: false,
      snapshot: null,
      healthSnapshot: null,
    });
    await settle();
  });

  it("surfaces unexpected capture failures as a capture_error status event", async () => {
    h.captureLifeOpsActivitySignal.mockRejectedValue(new Error("boom"));

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error", message: "boom" }),
    );
  });

  it("surfaces an unexpected (non-transport) status-probe failure instead of reading it as not-ready", async () => {
    h.getStatus.mockRejectedValue(new TypeError("status DTO shape broken"));

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    // No capture happens (the probe failed) …
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    // … but the failure is observable, not collapsed into silent not-ready.
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "capture_error",
        message: "status DTO shape broken",
      }),
    );
  });

  it("treats a transport-level status-probe failure as expected runtime unavailability", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({ kind: "network" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
  });

  it("treats a 503 status-probe response as expected runtime unavailability", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({ kind: "http", status: 503 });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
  });

  it("surfaces a persistent 5xx status-probe failure instead of reading it as not-ready forever", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({
      kind: "http",
      status: 500,
      message: "status endpoint exploded",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("silently swallows transient network errors without a status event", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({ kind: "network" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("stops sending after a 503 runtime-unavailable response", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({
      kind: "http",
      status: 503,
      path: "/api/lifeops/activity-signals",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("removes every listener and interval on stop", async () => {
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const removeWin = vi.spyOn(window, "removeEventListener");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    await stop();
    stop = undefined;

    expect(removeDoc).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeWin).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith("blur", expect.any(Function));
    // Ready poller + heartbeat + desktop poller are all cleared.
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    removeDoc.mockRestore();
    removeWin.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
