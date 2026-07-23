/**
 * Imperative renderer-side controller that captures presence/health/screen-time
 * activity signals and posts them to the LifeOps activity-signals endpoint:
 * browser lifecycle listeners on every platform, the Capacitor MobileSignals
 * plugin on native mobile, and the Electrobun power/workspace bridge on
 * desktop. Signals are deduped by per-source fingerprint and re-captured on app
 * resume.
 *
 * The renderer-service host starts this via `../register.ts`
 * (`registerRendererService`), scoped to main app windows only — never
 * popouts, detached shells, the phone companion, app windows, or the model
 * tester. The controller upholds three hard guarantees (#16504):
 *
 * - **Idempotent start.** One capture per renderer: a second start while one
 *   is active returns the active capture's stop function instead of installing
 *   duplicate listeners/pollers. Stop fully releases the singleton so a later
 *   start re-initializes cleanly (host replacement, HMR).
 * - **Race-safe stop.** Native startup awaits (permission check, listener
 *   registration, monitor start) re-check the stop flag after every await:
 *   stopping mid-start removes the late listener handle, stops monitoring if
 *   it already engaged, and never installs a late poller interval.
 * - **No capture before consent.** Native monitoring starts only when the OS
 *   permission status is already "granted". This background service never
 *   prompts — requesting permission is the settings UI's job — and a denial
 *   is surfaced as a `permission_unavailable` status event, then re-checked on
 *   each app resume so a grant made in Settings activates without a restart.
 *
 * Expected unavailability (runtime not yet running, transient network/timeout,
 * endpoint 503) quietly stands the capture down until the ready-poll recovers.
 * Anything else is an unexpected failure and is surfaced observably: a
 * `capture_error` status event plus a prefixed console.error.
 */
import { Capacitor } from "@capacitor/core";
import {
  MobileSignals,
  type MobileSignalsHealthSnapshot,
  type MobileSignalsSignal,
  type MobileSignalsSnapshot,
} from "@elizaos/capacitor-mobile-signals";
// The LifeOps client methods this controller calls are installed onto
// ElizaClient.prototype by the client-lifeops side-effect module. Import it
// here, not just in the root facade: the register entry can evaluate before
// (or without) the PA root facade, and the capture must never race the
// prototype extension — without this import, boot-batch signals are lost and
// surface as spurious capture_error until the idle facade load lands.
import "../api/client-lifeops.js";
// Narrow @elizaos/ui subpaths only — the root barrel drags react-router and
// the full component tree into this headless register chunk, which both
// bloats the renderer bundle and breaks under node module resolution in test
// lanes. (isApiError also only carries its type-guard on the /api subpath.)
import { client as apiClient, isApiError } from "@elizaos/ui/api";
import { isElectrobunRuntime } from "@elizaos/ui/bridge";
import { loadDesktopWorkspaceSnapshot } from "@elizaos/ui/browser";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "@elizaos/ui/events";
import type { LifeOpsElizaClientMethods } from "../api/client-lifeops.js";
import type {
  CaptureLifeOpsActivitySignalRequest,
  LifeOpsActivitySignal,
} from "../contracts/index.js";
import { dispatchLifeOpsActivitySignalsStatus } from "../events/index.js";

// client-lifeops (imported above for its side effect) installs the LifeOps
// methods onto ElizaClient.prototype before this module body runs, but its
// declaration merge targets the `@elizaos/ui` root barrel only — this headless
// chunk imports the /api subpath, so it re-types its view of the client with
// the one LifeOps method it calls.
const client = apiClient as typeof apiClient &
  Pick<LifeOpsElizaClientMethods, "captureLifeOpsActivitySignal">;

const LOG_PREFIX = "[LifeOpsActivitySignals]";

const APP_SIGNAL_DEDUP_WINDOW_MS = 5_000;
const RUNTIME_READY_POLL_MS = 5_000;
const PAGE_HEARTBEAT_MS = 60_000;
const DESKTOP_POWER_POLL_MS = 60_000;
// Health sleep data drives wake detection; five-minute polling keeps morning
// anchors timely without running while mobile monitoring is stopped.
const MOBILE_HEALTH_POLL_MS = 5 * 60_000;

type SignalFingerprint = {
  fingerprint: string;
  sentAtMs: number;
};

interface CapacitorRuntime {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
}

interface WindowWithCapacitor extends Window {
  Capacitor?: CapacitorRuntime;
}

function getWindowCapacitor(): CapacitorRuntime | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as WindowWithCapacitor).Capacitor;
}

function resolveCapacitorPlatform(): string {
  const importedPlatform = Capacitor.getPlatform();
  if (importedPlatform !== "web") {
    return importedPlatform;
  }
  return getWindowCapacitor()?.getPlatform?.() ?? importedPlatform;
}

function isNativeCapacitorRuntime(): boolean {
  return (
    Capacitor.isNativePlatform() ||
    getWindowCapacitor()?.isNativePlatform?.() === true ||
    ["ios", "android"].includes(resolveCapacitorPlatform())
  );
}

function resolveActivityPlatform(): string {
  if (isElectrobunRuntime()) {
    return "desktop_app";
  }
  if (isNativeCapacitorRuntime()) {
    return "mobile_app";
  }
  return "web_app";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function fingerprintSignal(
  signal: CaptureLifeOpsActivitySignalRequest,
): string {
  return JSON.stringify([
    signal.source,
    signal.platform ?? "",
    signal.state,
    signal.idleState ?? "",
    signal.idleTimeSeconds ?? "",
    signal.onBattery ?? "",
    signal.metadata ?? {},
  ]);
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toIsoOrNow(value: unknown): string {
  return toIsoOrNull(value) ?? new Date().toISOString();
}

function mapMobileSignal(
  signal: MobileSignalsSignal,
): CaptureLifeOpsActivitySignalRequest {
  return {
    source: signal.source,
    platform: signal.platform,
    state: signal.state,
    observedAt: toIsoOrNow(signal.observedAt),
    idleState: signal.idleState,
    idleTimeSeconds: signal.idleTimeSeconds ?? undefined,
    onBattery: signal.onBattery ?? undefined,
    health:
      signal.source === "mobile_health"
        ? {
            source: signal.healthSource,
            permissions: signal.permissions,
            sleep: {
              available: signal.sleep.available,
              isSleeping: signal.sleep.isSleeping,
              asleepAt: toIsoOrNull(signal.sleep.asleepAt),
              awakeAt: toIsoOrNull(signal.sleep.awakeAt),
              durationMinutes: signal.sleep.durationMinutes,
              stage: signal.sleep.stage,
            },
            biometrics: {
              sampleAt: toIsoOrNull(signal.biometrics.sampleAt),
              heartRateBpm: signal.biometrics.heartRateBpm,
              restingHeartRateBpm: signal.biometrics.restingHeartRateBpm,
              heartRateVariabilityMs: signal.biometrics.heartRateVariabilityMs,
              respiratoryRate: signal.biometrics.respiratoryRate,
              bloodOxygenPercent: signal.biometrics.bloodOxygenPercent,
            },
            warnings: signal.warnings,
          }
        : undefined,
    metadata:
      signal.source === "mobile_health"
        ? { ...signal.metadata, screenTime: signal.screenTime }
        : signal.metadata,
  };
}

export type LifeOpsActivitySignalCaptureCleanup = () => Promise<void>;

// One capture per renderer window. The active cleanup remains installed until
// its asynchronous native teardown has settled, so a replacement cannot race
// an old generation's late stopMonitoring/remove/background-cancel calls.
let activeCaptureStop: LifeOpsActivitySignalCaptureCleanup | null = null;

export function startLifeOpsActivitySignalCapture(
  enabled = true,
  serviceSignal?: AbortSignal,
): LifeOpsActivitySignalCaptureCleanup {
  if (!enabled || typeof window === "undefined") {
    return async () => {};
  }
  if (activeCaptureStop) {
    return activeCaptureStop;
  }

  const platform = resolveActivityPlatform();
  const lastSent = new Map<string, SignalFingerprint>();
  const captureController = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  let runtimeReady = false;
  let mounted = true;

  const track = <T>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => {
      inFlight.delete(tracked);
    });
    inFlight.add(tracked);
    return tracked;
  };

  const settleInFlight = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  };

  const isRuntimeUnavailableError = (error: unknown): boolean =>
    isApiError(error) &&
    error.kind === "http" &&
    error.status === 503 &&
    error.path === "/api/lifeops/activity-signals";

  const isExpectedTransientError = (error: unknown): boolean =>
    isApiError(error) && (error.kind === "network" || error.kind === "timeout");

  const reportCaptureError = (error: unknown): void => {
    if (!mounted || isAbortError(error)) {
      return;
    }
    if (isRuntimeUnavailableError(error)) {
      runtimeReady = false;
      return;
    }
    if (isExpectedTransientError(error)) {
      return;
    }
    // Unexpected failure: surface it observably — status event for in-app
    // listeners plus a prefixed console line for log capture — instead of
    // letting the capture silently rot.
    console.error(`${LOG_PREFIX} unexpected capture failure:`, error);
    dispatchLifeOpsActivitySignalsStatus({
      status: "capture_error",
      message: errorMessage(error),
    });
  };

  // Runtime not up yet (boot, restart) is the designed stand-down state; only
  // transport loss and the 503 "runtime starting" shape count as that state.
  // Anything else coming out of the status probe (persistent 500s included) is
  // a real defect and must surface, not read as "not ready" forever (#16504).
  const isExpectedProbeFailure = (error: unknown): boolean =>
    isApiError(error) &&
    (error.kind === "network" ||
      error.kind === "timeout" ||
      (error.kind === "http" && error.status === 503));

  const refreshRuntimeReady = async (): Promise<boolean> => {
    try {
      const status = await client.getStatus();
      const ready = status.state === "running";
      runtimeReady = ready;
      return ready;
    } catch (error) {
      // error-policy:J4 capture stands down until a later poll succeeds;
      // unexpected probe failures still surface as a capture_error status.
      runtimeReady = false;
      if (!isExpectedProbeFailure(error)) {
        reportCaptureError(error);
      }
      return false;
    }
  };

  const sendSignal = async (
    signal: CaptureLifeOpsActivitySignalRequest,
  ): Promise<LifeOpsActivitySignal | null> => {
    if (!mounted || !runtimeReady) {
      return null;
    }
    const normalized: CaptureLifeOpsActivitySignalRequest = {
      ...signal,
      platform: signal.platform ?? platform,
    };
    const fingerprint = fingerprintSignal(normalized);
    const dedupeKey = `${normalized.source}:${normalized.platform ?? ""}`;
    const previous = lastSent.get(dedupeKey);
    const nowMs = Date.now();
    if (
      previous &&
      previous.fingerprint === fingerprint &&
      nowMs - previous.sentAtMs < APP_SIGNAL_DEDUP_WINDOW_MS
    ) {
      return null;
    }
    lastSent.set(dedupeKey, { fingerprint, sentAtMs: nowMs });
    try {
      const { signal: persisted } = await client.captureLifeOpsActivitySignal(
        normalized,
        {
          signal: captureController.signal,
        },
      );
      if (!mounted) {
        return null;
      }
      return persisted;
    } catch (error) {
      lastSent.delete(dedupeKey);
      if (!mounted || isAbortError(error)) {
        return null;
      }
      if (isRuntimeUnavailableError(error)) {
        runtimeReady = false;
        return null;
      }
      throw error;
    }
  };

  const sendSnapshotResult = async (result: {
    snapshot: MobileSignalsSnapshot | null;
    healthSnapshot: MobileSignalsHealthSnapshot | null;
  }): Promise<void> => {
    if (result.snapshot) {
      await sendSignal(mapMobileSignal(result.snapshot));
    }
    if (result.healthSnapshot) {
      await sendSignal(mapMobileSignal(result.healthSnapshot));
    }
  };

  const fireAndForget = (signal: CaptureLifeOpsActivitySignalRequest): void => {
    void track(sendSignal(signal)).catch(reportCaptureError);
  };

  const emitPageState = (reason: string): void => {
    const isVisible = document.visibilityState === "visible";
    const hasFocus =
      typeof document.hasFocus === "function" ? document.hasFocus() : true;
    fireAndForget({
      source: "page_visibility",
      state: isVisible && hasFocus ? "active" : "background",
      metadata: {
        reason,
        visibilityState: document.visibilityState,
        hasFocus,
      },
    });
  };

  const emitLifecycleState = (state: "active" | "background"): void => {
    fireAndForget({
      source: "app_lifecycle",
      state,
      metadata: { reason: state === "active" ? "resume" : "pause" },
    });
  };

  const emitDesktopSnapshot = async (reason: string): Promise<void> => {
    try {
      if (!isElectrobunRuntime()) {
        return;
      }
      const snapshot = await loadDesktopWorkspaceSnapshot();
      if (!snapshot.supported || !snapshot.power) {
        return;
      }

      const state =
        snapshot.power.idleState === "locked"
          ? "locked"
          : snapshot.power.idleState === "idle"
            ? "idle"
            : snapshot.window.focused && document.visibilityState === "visible"
              ? "active"
              : "background";
      await sendSignal({
        source: "desktop_power",
        state,
        idleState: snapshot.power.idleState,
        idleTimeSeconds: Math.max(0, Math.trunc(snapshot.power.idleTime)),
        onBattery: snapshot.power.onBattery,
        metadata: {
          reason,
          windowFocused: snapshot.window.focused,
          windowVisible: snapshot.window.visible,
          documentVisibility: document.visibilityState,
        },
      });
    } catch (error) {
      // error-policy:J7 the desktop snapshot poll must not kill the capture
      // loop; unexpected failures are surfaced through reportCaptureError.
      reportCaptureError(error);
    }
  };

  const handleVisibilityChange = (): void => {
    emitPageState("visibilitychange");
  };
  const handleFocus = (): void => {
    emitPageState("focus");
    void track(emitDesktopSnapshot("focus"));
  };
  const handleBlur = (): void => {
    emitPageState("blur");
    void track(emitDesktopSnapshot("blur"));
  };
  const handleResume = (): void => {
    emitLifecycleState("active");
    emitPageState("resume");
    void track(refreshMobileHealthSnapshot("resume")).catch(reportCaptureError);
    void track(emitDesktopSnapshot("resume"));
    // A permission granted in OS Settings while the app was backgrounded
    // becomes effective here: startMobileSignals re-checks consent and is a
    // cheap no-op when monitoring is already running.
    void requestMobileSignalsStart().catch(reportCaptureError);
  };
  const handlePause = (): void => {
    emitLifecycleState("background");
    emitPageState("pause");
    void track(refreshMobileHealthSnapshot("pause")).catch(reportCaptureError);
    void track(emitDesktopSnapshot("pause"));
  };

  const mobileSignals =
    isNativeCapacitorRuntime() && !isElectrobunRuntime() ? MobileSignals : null;
  let mobileSignalsHandle: { remove: () => Promise<void> } | null = null;
  let mobileSignalsStarted = false;
  let mobileSignalsStartTask: Promise<void> | null = null;
  let mobileSignalsStartupAttempted = false;
  let mobileHealthPoller: number | null = null;
  const nativeTeardownFailures: unknown[] = [];

  const refreshMobileHealthSnapshot = async (reason: string): Promise<void> => {
    if (!mobileSignals || typeof mobileSignals.getSnapshot !== "function") {
      return;
    }
    const snapshot = await mobileSignals.getSnapshot();
    if (snapshot.supported) {
      await sendSnapshotResult(snapshot);
    } else {
      dispatchLifeOpsActivitySignalsStatus({
        status: "snapshot_unavailable",
        reason,
      });
    }
  };

  const cleanPartialNativeStart = async (
    handle: { remove: () => Promise<void> } | null,
  ): Promise<void> => {
    if (!mobileSignals) return;
    const cleanupResults = await Promise.allSettled([
      handle?.remove() ?? Promise.resolve(),
      mobileSignals.stopMonitoring(),
      typeof mobileSignals.cancelBackgroundRefresh === "function"
        ? mobileSignals.cancelBackgroundRefresh()
        : Promise.resolve(),
    ]);
    mobileSignalsStartupAttempted = false;
    const failures = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      nativeTeardownFailures.push(...failures);
      throw new AggregateError(
        failures,
        "Failed to roll back partially started mobile activity monitoring",
      );
    }
  };

  const startMobileSignals = async (): Promise<void> => {
    if (mobileSignalsHandle || mobileSignalsStarted) return;
    if (
      !mobileSignals ||
      typeof mobileSignals.addListener !== "function" ||
      typeof mobileSignals.checkPermissions !== "function" ||
      typeof mobileSignals.startMonitoring !== "function" ||
      typeof mobileSignals.stopMonitoring !== "function"
    ) {
      return;
    }

    let pendingHandle: { remove: () => Promise<void> } | null = null;
    let committed = false;
    try {
      const permissions = await mobileSignals.checkPermissions();
      if (!mounted) return;
      if (
        permissions.status !== "granted" &&
        permissions.status !== "not-applicable"
      ) {
        // Consent gate: never begin monitoring (or prompt) without a grant.
        // The settings UI owns requesting; resume re-checks pick up a grant.
        dispatchLifeOpsActivitySignalsStatus({
          status: "permission_unavailable",
          reason: permissions.status,
        });
        return;
      }

      pendingHandle = await mobileSignals.addListener(
        "signal",
        (signal: MobileSignalsSignal) => {
          void track(sendSignal(mapMobileSignal(signal))).catch(
            reportCaptureError,
          );
        },
      );
      if (!mounted) {
        await cleanPartialNativeStart(pendingHandle);
        return;
      }

      mobileSignalsStartupAttempted = true;
      const initial = await mobileSignals.startMonitoring({
        emitInitial: true,
      });
      if (!mounted || !initial.enabled) {
        await cleanPartialNativeStart(pendingHandle);
        return;
      }

      // Commit the handle and monitor as one generation only after native
      // startup succeeds. A rejection or disabled result above leaves no
      // durable handle, so a later resume can retry instead of wedging forever.
      mobileSignalsHandle = pendingHandle;
      pendingHandle = null;
      mobileSignalsStarted = initial.enabled;
      committed = true;
      await sendSnapshotResult(initial);
      await refreshMobileHealthSnapshot("start");
      if (!mounted) return;
      if (typeof mobileSignals.scheduleBackgroundRefresh === "function") {
        try {
          const result = await mobileSignals.scheduleBackgroundRefresh();
          if (mounted && !result.scheduled && result.reason) {
            dispatchLifeOpsActivitySignalsStatus({
              status: "background_refresh_unavailable",
              reason: result.reason,
            });
          }
        } catch (error) {
          // error-policy:J7 background-refresh scheduling is an enhancement;
          // its failure is reported without killing the started capture.
          reportCaptureError(error);
        }
      }
      if (!mounted) return;
      mobileHealthPoller = window.setInterval(() => {
        void track(refreshMobileHealthSnapshot("poll")).catch(
          reportCaptureError,
        );
      }, MOBILE_HEALTH_POLL_MS);
    } catch (error) {
      if (!committed && (pendingHandle || mobileSignalsStartupAttempted)) {
        try {
          await cleanPartialNativeStart(pendingHandle);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Mobile activity monitoring startup and rollback failed",
          );
        }
      }
      throw error;
    }
  };

  const requestMobileSignalsStart = (): Promise<void> => {
    if (mobileSignalsStartTask) return mobileSignalsStartTask;
    const task = track(startMobileSignals()).finally(() => {
      if (mobileSignalsStartTask === task) {
        mobileSignalsStartTask = null;
      }
    });
    mobileSignalsStartTask = task;
    return task;
  };

  const emitCurrentState = (reason: string): void => {
    emitLifecycleState("active");
    emitPageState(reason);
    void track(emitDesktopSnapshot(reason));
    void track(refreshMobileHealthSnapshot(reason)).catch(reportCaptureError);
  };

  void track(
    refreshRuntimeReady().then(async (ready) => {
      if (ready && mounted) {
        emitCurrentState("mount");
        await requestMobileSignalsStart();
      }
    }),
  ).catch(reportCaptureError);

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener(APP_RESUME_EVENT, handleResume);
  document.addEventListener(APP_PAUSE_EVENT, handlePause);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("blur", handleBlur);

  const runtimePoller = window.setInterval(() => {
    const wasReady = runtimeReady;
    void track(
      refreshRuntimeReady().then(async (ready) => {
        if (!mounted || !ready || wasReady) {
          return;
        }
        emitCurrentState("runtime-ready");
        await requestMobileSignalsStart();
      }),
    ).catch(reportCaptureError);
  }, RUNTIME_READY_POLL_MS);
  const pageHeartbeat = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      emitPageState("heartbeat");
    }
  }, PAGE_HEARTBEAT_MS);
  const desktopPoller = window.setInterval(() => {
    void track(emitDesktopSnapshot("poll"));
  }, DESKTOP_POWER_POLL_MS);

  let stopPromise: Promise<void> | null = null;
  let detachServiceAbort = (): void => {};
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    mounted = false;
    runtimeReady = false;
    captureController.abort();
    detachServiceAbort();
    detachServiceAbort = () => {};
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.removeEventListener(APP_RESUME_EVENT, handleResume);
    document.removeEventListener(APP_PAUSE_EVENT, handlePause);
    window.removeEventListener("focus", handleFocus);
    window.removeEventListener("blur", handleBlur);
    if (mobileHealthPoller !== null) {
      window.clearInterval(mobileHealthPoller);
      mobileHealthPoller = null;
    }
    window.clearInterval(runtimePoller);
    window.clearInterval(pageHeartbeat);
    window.clearInterval(desktopPoller);

    stopPromise = (async () => {
      await settleInFlight();

      const teardownFailures = [...nativeTeardownFailures];
      const handle = mobileSignalsHandle;
      mobileSignalsHandle = null;
      const shouldStopMonitoring =
        mobileSignalsStarted || mobileSignalsStartupAttempted;
      mobileSignalsStarted = false;
      mobileSignalsStartupAttempted = false;

      if (handle) {
        try {
          await handle.remove();
        } catch (error) {
          // error-policy:J6 native teardown continues so one failed resource
          // release cannot strand the remaining monitor/background job.
          teardownFailures.push(error);
        }
      }
      if (mobileSignals && shouldStopMonitoring) {
        try {
          await mobileSignals.stopMonitoring();
        } catch (error) {
          // error-policy:J6 see listener removal above.
          teardownFailures.push(error);
        }
      }
      if (
        mobileSignals &&
        typeof mobileSignals.cancelBackgroundRefresh === "function"
      ) {
        try {
          await mobileSignals.cancelBackgroundRefresh();
        } catch (error) {
          // error-policy:J6 see listener removal above.
          teardownFailures.push(error);
        }
      }

      if (teardownFailures.length > 0) {
        throw new AggregateError(
          teardownFailures,
          "Failed to fully stop LifeOps native activity capture",
        );
      }
    })().finally(() => {
      if (activeCaptureStop === stop) {
        activeCaptureStop = null;
      }
    });
    return stopPromise;
  };

  activeCaptureStop = stop;
  if (serviceSignal) {
    const onServiceAbort = () => {
      void stop();
    };
    serviceSignal.addEventListener("abort", onServiceAbort, { once: true });
    detachServiceAbort = () =>
      serviceSignal.removeEventListener("abort", onServiceAbort);
    if (serviceSignal.aborted) {
      void stop();
    }
  }
  return stop;
}

/** True while a capture instance is active — diagnostics/tests only. */
export function isLifeOpsActivitySignalCaptureActive(): boolean {
  return activeCaptureStop !== null;
}
