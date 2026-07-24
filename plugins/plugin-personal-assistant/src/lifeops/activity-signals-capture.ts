/**
 * Captures browser, native-mobile, and desktop activity signals for the LifeOps
 * activity-signals endpoint. The renderer-service host installs one controller
 * in each main app window; popouts, companion surfaces, and model tools do not
 * participate.
 *
 * Native ownership is generation-scoped. A generation owns its callbacks,
 * reads, uploads, poller, and background-scheduling request, and teardown aborts
 * and settles that work before a successor can start. Monitoring never prompts:
 * it begins only after the OS records an authorization decision and revalidates
 * that decision on resume. iOS can expose only that HealthKit authorization was
 * determined, not which read types were granted.
 *
 * Runtime startup, transport loss, timeouts, and an endpoint 503 are designed
 * stand-down states. Other failures emit a `capture_error` status and remain
 * visible in renderer diagnostics.
 */
import { Capacitor } from "@capacitor/core";
import {
  MobileSignals,
  type MobileSignalsHealthSnapshot,
  type MobileSignalsPermissionStatus,
  type MobileSignalsSignal,
  type MobileSignalsSnapshot,
} from "@elizaos/capacitor-mobile-signals";
import { ElizaError } from "@elizaos/core";
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

type MobileSignalsGeneration = {
  controller: AbortController;
  operations: Set<Promise<unknown>>;
  refreshTask: Promise<void> | null;
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

function combinedLifecycleError(
  message: string,
  code: string,
  causes: unknown[],
): ElizaError {
  return new ElizaError(message, {
    code,
    cause: new AggregateError(causes, message),
    severity: "ephemeral",
  });
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
// asynchronous native teardown succeeds; failed releases retain their
// ownership ledger for retry instead of allowing a replacement to overlap an
// old generation's stopMonitoring/remove/background-cancel calls.
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
  let mobileSignalsGeneration: MobileSignalsGeneration | null = null;
  let mobileSignalsCommitted = false;

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

  const trackMobileSignalsOperation = <T>(
    generation: MobileSignalsGeneration,
    run: () => Promise<T>,
  ): Promise<T> => {
    // Install the lease before invoking the boundary: a native/client shim may
    // synchronously trigger pagehide or consent teardown from inside `run`.
    let releaseOwnership!: () => void;
    const ownership = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    generation.operations.add(ownership);

    let operation: Promise<T>;
    try {
      operation = run();
    } catch (error) {
      // error-policy:J1 normalize a synchronous native boundary throw into the
      // same generation-owned operation and observable rejection.
      operation = Promise.reject(error);
    }
    const tracked = operation.finally(() => {
      generation.operations.delete(ownership);
      releaseOwnership();
    });
    return tracked;
  };

  const settleMobileSignalsOperations = async (
    generation: MobileSignalsGeneration,
  ): Promise<void> => {
    while (generation.operations.size > 0) {
      await Promise.allSettled([...generation.operations]);
    }
  };

  const isCurrentMobileSignalsGeneration = (
    generation: MobileSignalsGeneration,
  ): boolean =>
    mounted &&
    mobileSignalsCommitted &&
    mobileSignalsGeneration === generation &&
    !generation.controller.signal.aborted;

  const isRuntimeUnavailableError = (error: unknown): boolean =>
    isApiError(error) &&
    error.kind === "http" &&
    error.status === 503 &&
    error.path === "/api/lifeops/activity-signals";

  const isExpectedTransientError = (error: unknown): boolean =>
    isApiError(error) && (error.kind === "network" || error.kind === "timeout");

  const captureErrorLeaves = (error: unknown): unknown[] =>
    error instanceof AggregateError
      ? [...error.errors].flatMap(captureErrorLeaves)
      : error instanceof ElizaError && error.cause !== undefined
        ? captureErrorLeaves(error.cause)
        : [error];

  const reportCaptureError = (error: unknown): void => {
    if (!mounted) return;

    const unexpected: unknown[] = [];
    for (const cause of captureErrorLeaves(error)) {
      if (isAbortError(cause)) continue;
      if (isRuntimeUnavailableError(cause)) {
        runtimeReady = false;
        continue;
      }
      if (isExpectedTransientError(cause)) continue;
      unexpected.push(cause);
    }
    if (unexpected.length === 0) return;

    const reported =
      unexpected.length === 1
        ? unexpected[0]
        : new AggregateError(
            unexpected,
            "Multiple LifeOps activity capture operations failed",
          );
    // Unexpected failure: surface it observably — status event for in-app
    // listeners plus a prefixed console line for log capture — instead of
    // letting the capture silently rot.
    console.error(`${LOG_PREFIX} unexpected capture failure:`, reported);
    dispatchLifeOpsActivitySignalsStatus({
      status: "capture_error",
      message: errorMessage(reported),
    });
  };

  const observeCaptureOperation = <T>(operation: Promise<T>): void => {
    // error-policy:J7 renderer capture diagnostics must not kill the controller;
    // unexpected failures still surface through reportCaptureError.
    void track(operation).catch(reportCaptureError);
  };

  const observeUnownedProbe = <T>(operation: Promise<T>): void => {
    // error-policy:J7 read-only bridge probes have no cancellation boundary and
    // therefore cannot be teardown-owned. Their late effects are generation
    // fenced, while failures still surface through the capture diagnostics.
    void operation.catch(reportCaptureError);
  };

  const observeMobileSignalsOperation = <T>(
    generation: MobileSignalsGeneration,
    operation: () => Promise<T>,
  ): void => {
    observeCaptureOperation(trackMobileSignalsOperation(generation, operation));
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
    if (!mounted) return false;
    try {
      const status = await client.getStatus();
      if (!mounted) return false;
      const ready = status.state === "running";
      runtimeReady = ready;
      return ready;
    } catch (error) {
      // error-policy:J4 capture stands down until a later poll succeeds;
      // unexpected probe failures still surface as a capture_error status.
      if (!mounted) return false;
      runtimeReady = false;
      if (!isExpectedProbeFailure(error)) {
        reportCaptureError(error);
      }
      return false;
    }
  };

  const sendSignal = async (
    signal: CaptureLifeOpsActivitySignalRequest,
    generation?: MobileSignalsGeneration,
  ): Promise<LifeOpsActivitySignal | null> => {
    if (
      !mounted ||
      !runtimeReady ||
      (generation !== undefined &&
        !isCurrentMobileSignalsGeneration(generation))
    ) {
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
    const sentFingerprint = { fingerprint, sentAtMs: nowMs };
    lastSent.set(dedupeKey, sentFingerprint);
    try {
      const { signal: persisted } = await client.captureLifeOpsActivitySignal(
        normalized,
        {
          signal: generation?.controller.signal ?? captureController.signal,
        },
      );
      if (
        !mounted ||
        (generation !== undefined &&
          !isCurrentMobileSignalsGeneration(generation))
      ) {
        return null;
      }
      return persisted;
    } catch (error) {
      // error-policy:J4 abort and runtime-starting failures are explicit
      // stand-down states; every other transport failure is rethrown.
      if (lastSent.get(dedupeKey) === sentFingerprint) {
        lastSent.delete(dedupeKey);
      }
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

  const sendSnapshotResult = async (
    result: {
      snapshot: MobileSignalsSnapshot | null;
      healthSnapshot: MobileSignalsHealthSnapshot | null;
    },
    generation: MobileSignalsGeneration,
  ): Promise<void> => {
    const sends: Promise<LifeOpsActivitySignal | null>[] = [];
    if (result.snapshot) {
      sends.push(sendSignal(mapMobileSignal(result.snapshot), generation));
    }
    if (result.healthSnapshot) {
      sends.push(
        sendSignal(mapMobileSignal(result.healthSnapshot), generation),
      );
    }
    const outcomes = await Promise.allSettled(sends);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw combinedLifecycleError(
        "Failed to persist one or more mobile activity snapshots",
        "MOBILE_SIGNAL_SNAPSHOT_PERSIST_FAILED",
        failures,
      );
    }
  };

  const fireAndForget = (signal: CaptureLifeOpsActivitySignalRequest): void => {
    observeCaptureOperation(sendSignal(signal));
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

  let desktopSnapshotProbeTask: Promise<void> | null = null;
  const requestDesktopSnapshot = (reason: string): void => {
    if (!mounted || desktopSnapshotProbeTask || !isElectrobunRuntime()) {
      return;
    }

    let resolveProbe!: () => void;
    let rejectProbe!: (error: unknown) => void;
    const probeTask = new Promise<void>((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    // Publish the single-flight token before entering Electrobun. A wedged
    // workspace RPC must retain at most one read-only probe, never one fan-out
    // per focus/poll event.
    desktopSnapshotProbeTask = probeTask;
    const reading = (async () => {
      const snapshot = await loadDesktopWorkspaceSnapshot();
      if (!mounted || !snapshot.supported || !snapshot.power) {
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
      // The unbounded read is not teardown-owned; once it produces a value,
      // persistence crosses the abortable, teardown-owned boundary separately.
      fireAndForget({
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
    })();
    void reading.then(
      () => {
        if (desktopSnapshotProbeTask === probeTask) {
          desktopSnapshotProbeTask = null;
        }
        resolveProbe();
      },
      (error) => {
        if (desktopSnapshotProbeTask === probeTask) {
          desktopSnapshotProbeTask = null;
        }
        rejectProbe(error);
      },
    );
    observeUnownedProbe(probeTask);
  };

  const handleVisibilityChange = (): void => {
    emitPageState("visibilitychange");
  };
  const handleFocus = (): void => {
    emitPageState("focus");
    requestDesktopSnapshot("focus");
  };
  const handleBlur = (): void => {
    emitPageState("blur");
    requestDesktopSnapshot("blur");
  };
  const handleResume = (): void => {
    emitLifecycleState("active");
    emitPageState("resume");
    requestDesktopSnapshot("resume");
    // A permission granted in OS Settings while the app was backgrounded
    // becomes effective here, while a revoked grant stops existing native
    // ownership before any fresh health read can begin.
    requestMobileSignalsResume();
  };
  const handlePause = (): void => {
    emitLifecycleState("background");
    emitPageState("pause");
    requestMobileHealthSnapshot("pause");
    requestDesktopSnapshot("pause");
  };

  const mobileSignals =
    isNativeCapacitorRuntime() && !isElectrobunRuntime() ? MobileSignals : null;
  let pendingMobileSignalsHandle: { remove: () => Promise<void> } | null = null;
  let mobileSignalsHandle: { remove: () => Promise<void> } | null = null;
  let mobileSignalsStarted = false;
  let mobileSignalsStartTask: Promise<void> | null = null;
  let mobileSignalsResumeTask: Promise<void> | null = null;
  let requestedConsentRevalidation = 0;
  let attemptedConsentRevalidation = 0;
  let mobileSignalsStartupAttempted = false;
  let mobileSignalListenersNeedRelease = false;
  let mobileBackgroundRefreshNeedsCancel = false;
  let mobileBackgroundRefreshScheduleTask: Promise<void> | null = null;
  let nativeReleaseTask: Promise<void> | null = null;
  let mobileHealthPoller: number | null = null;

  const clearMobileHealthPoller = (): void => {
    if (mobileHealthPoller === null) return;
    window.clearInterval(mobileHealthPoller);
    mobileHealthPoller = null;
  };

  const requestMobileHealthSnapshot = (
    reason: string,
    requestedGeneration: MobileSignalsGeneration | null = mobileSignalsGeneration,
  ): void => {
    if (
      !requestedGeneration ||
      !isCurrentMobileSignalsGeneration(requestedGeneration) ||
      !mobileSignals ||
      typeof mobileSignals.getSnapshot !== "function"
    ) {
      return;
    }
    if (requestedGeneration.refreshTask) return;

    let resolveRefresh!: () => void;
    let rejectRefresh!: (error: unknown) => void;
    const refreshTask = new Promise<void>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });
    // Publish the single-flight lease before invoking getSnapshot(). A bridge
    // shim can synchronously dispatch pause/resume while the boundary is being
    // entered; that reentrant path must observe this read as already owned.
    requestedGeneration.refreshTask = refreshTask;
    const reading = trackMobileSignalsOperation(
      requestedGeneration,
      async () => {
        const snapshot = await mobileSignals.getSnapshot();
        if (!isCurrentMobileSignalsGeneration(requestedGeneration)) {
          return;
        }
        if (snapshot.supported) {
          await sendSnapshotResult(snapshot, requestedGeneration);
        } else {
          dispatchLifeOpsActivitySignalsStatus({
            status: "snapshot_unavailable",
            reason,
          });
        }
      },
    );
    void reading.then(
      () => {
        if (requestedGeneration.refreshTask === refreshTask) {
          requestedGeneration.refreshTask = null;
        }
        resolveRefresh();
      },
      (error) => {
        if (requestedGeneration.refreshTask === refreshTask) {
          requestedGeneration.refreshTask = null;
        }
        rejectRefresh(error);
      },
    );
    observeCaptureOperation(refreshTask);
  };

  const hasNativeOwnership = (): boolean =>
    mobileSignalsGeneration !== null ||
    pendingMobileSignalsHandle !== null ||
    mobileSignalsHandle !== null ||
    mobileSignalListenersNeedRelease ||
    mobileSignalsStarted ||
    mobileSignalsCommitted ||
    mobileSignalsStartupAttempted ||
    mobileBackgroundRefreshNeedsCancel ||
    mobileBackgroundRefreshScheduleTask !== null;

  const releaseNativeOwnership = (): Promise<void> => {
    if (!mobileSignals) return Promise.resolve();
    // Suspending the commit bit before the first native await prevents a
    // poller or already-queued callback from reading/sending while consent or
    // ownership is uncertain. Granular obligations below remain set until
    // their native postconditions are individually proved.
    mobileSignalsCommitted = false;
    clearMobileHealthPoller();
    if (nativeReleaseTask) return nativeReleaseTask;

    let resolveRelease!: () => void;
    let rejectRelease!: (error: unknown) => void;
    const releaseTask = new Promise<void>((resolve, reject) => {
      resolveRelease = resolve;
      rejectRelease = reject;
    });
    // Publish the teardown owner before invoking any native method. Capacitor
    // shims can synchronously re-enter stop() while a bridge call is being
    // created; that path must join this attempt rather than duplicate release.
    nativeReleaseTask = releaseTask;

    try {
      const generationAtRelease = mobileSignalsGeneration;
      if (generationAtRelease) {
        mobileSignalsGeneration = null;
        generationAtRelease.controller.abort();
      }
      const settlingGeneration = generationAtRelease
        ? settleMobileSignalsOperations(generationAtRelease)
        : Promise.resolve();
      const scheduleTaskAtRelease = mobileBackgroundRefreshScheduleTask;
      const shouldReleaseListeners =
        mobileSignalListenersNeedRelease ||
        pendingMobileSignalsHandle !== null ||
        mobileSignalsHandle !== null;
      const releasingListeners = shouldReleaseListeners
        ? typeof mobileSignals.releaseSignalListeners === "function"
          ? (async () => {
              const listenerHandles = [
                ...new Set(
                  [pendingMobileSignalsHandle, mobileSignalsHandle].filter(
                    (handle): handle is { remove: () => Promise<void> } =>
                      handle !== null,
                  ),
                ),
              ];
              const pendingHandleAtRelease = pendingMobileSignalsHandle;
              const committedHandleAtRelease = mobileSignalsHandle;
              const handleRemovals = listenerHandles.map((handle) => {
                try {
                  return Promise.resolve(handle.remove());
                } catch (error) {
                  // error-policy:J6 preserve synchronous handle failures as
                  // teardown outcomes while the authoritative native release is
                  // still invoked in this same pagehide turn.
                  return Promise.reject(error);
                }
              });
              for (const handleRemoval of handleRemovals) {
                void handleRemoval.catch((error) => {
                  // error-policy:J6 the package-owned native release below is
                  // the authoritative event-registry and bridge-callback
                  // postcondition; a stale generic wrapper cannot retain native
                  // ownership or block teardown once that fence succeeds.
                  console.warn(
                    `${LOG_PREFIX} generic mobile signal listener removal failed; the package-owned native release remains authoritative:`,
                    error,
                  );
                });
              }
              // The package call is authoritative and releases both native
              // ownership tables. Generic handles are advisory because Capacitor
              // does not acknowledge their nested removeListener call.
              const result = await mobileSignals.releaseSignalListeners();
              if (!result.removed) {
                throw new ElizaError(
                  "MobileSignals.releaseSignalListeners() did not establish the removed postcondition",
                  {
                    code: "MOBILE_SIGNAL_LISTENER_RELEASE_INCOMPLETE",
                    severity: "ephemeral",
                  },
                );
              }
              mobileSignalListenersNeedRelease = false;
              if (pendingMobileSignalsHandle === pendingHandleAtRelease) {
                pendingMobileSignalsHandle = null;
              }
              if (mobileSignalsHandle === committedHandleAtRelease) {
                mobileSignalsHandle = null;
              }
            })()
          : Promise.reject(
              new ElizaError(
                "MobileSignals.releaseSignalListeners() disappeared while listener ownership was recorded",
                {
                  code: "MOBILE_SIGNAL_LISTENER_RELEASE_UNAVAILABLE",
                  severity: "fatal",
                },
              ),
            )
        : Promise.resolve();
      const shouldStop = mobileSignalsStarted || mobileSignalsStartupAttempted;
      const stopping = shouldStop
        ? (async () => {
            const result = await mobileSignals.stopMonitoring();
            if (!result.stopped) {
              throw new ElizaError(
                "MobileSignals.stopMonitoring() did not establish the stopped postcondition",
                {
                  code: "MOBILE_SIGNAL_MONITOR_STOP_INCOMPLETE",
                  severity: "ephemeral",
                },
              );
            }
            mobileSignalsStarted = false;
            mobileSignalsCommitted = false;
            mobileSignalsStartupAttempted = false;
          })()
        : Promise.resolve();
      const shouldCancel = mobileBackgroundRefreshNeedsCancel;
      const cancelling = shouldCancel
        ? typeof mobileSignals.cancelBackgroundRefresh === "function"
          ? (async () => {
              const result = await mobileSignals.cancelBackgroundRefresh();
              if (!result.cancelled) {
                throw new ElizaError(
                  `MobileSignals.cancelBackgroundRefresh() did not establish the cancelled postcondition${
                    result.reason ? `: ${result.reason}` : ""
                  }`,
                  {
                    code: "MOBILE_SIGNAL_BACKGROUND_CANCEL_INCOMPLETE",
                    context: { reason: result.reason },
                    severity: "ephemeral",
                  },
                );
              }
              if (!scheduleTaskAtRelease) {
                mobileBackgroundRefreshNeedsCancel = false;
              }
            })()
          : Promise.reject(
              new ElizaError(
                "MobileSignals.cancelBackgroundRefresh() disappeared while a cancellation was owned",
                {
                  code: "MOBILE_SIGNAL_BACKGROUND_CANCEL_UNAVAILABLE",
                  severity: "fatal",
                },
              ),
            )
        : Promise.resolve();

      // Invoke every native release before the first await. A persisted pagehide
      // can freeze JavaScript immediately after this task, so listener removal,
      // monitor stop, and job cancellation must already be in the bridge queue.
      const attempt = (async () => {
        const [outcomes] = await Promise.all([
          Promise.allSettled([releasingListeners, stopping, cancelling]),
          settlingGeneration,
        ]);
        const failures = outcomes
          .slice(0, 2)
          .flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
        let cancellationFailure =
          outcomes[2]?.status === "rejected" ? outcomes[2].reason : null;

        // A schedule request may accept work after the first cancellation. Wait
        // only for that package-owned bridge call, then prove the job absent at
        // the later boundary. A hung call keeps this service safely uncommitted.
        if (scheduleTaskAtRelease) {
          await Promise.allSettled([scheduleTaskAtRelease]);
        }
        if (mobileBackgroundRefreshNeedsCancel) {
          if (typeof mobileSignals.cancelBackgroundRefresh !== "function") {
            cancellationFailure = new ElizaError(
              "MobileSignals.cancelBackgroundRefresh() disappeared while a cancellation was owned",
              {
                code: "MOBILE_SIGNAL_BACKGROUND_CANCEL_UNAVAILABLE",
                severity: "fatal",
              },
            );
          } else {
            try {
              const result = await mobileSignals.cancelBackgroundRefresh();
              if (!result.cancelled) {
                throw new ElizaError(
                  `MobileSignals.cancelBackgroundRefresh() did not establish the cancelled postcondition${
                    result.reason ? `: ${result.reason}` : ""
                  }`,
                  {
                    code: "MOBILE_SIGNAL_BACKGROUND_CANCEL_INCOMPLETE",
                    context: { reason: result.reason },
                    severity: "ephemeral",
                  },
                );
              }
              mobileBackgroundRefreshNeedsCancel = false;
              cancellationFailure = null;
            } catch (error) {
              // error-policy:J6 a cancellation that raced scheduling is retried
              // after that bridge call settles; the retained obligation blocks a
              // successor if the postcondition is still not established.
              cancellationFailure = error;
            }
          }
        }
        if (
          mobileBackgroundRefreshNeedsCancel &&
          cancellationFailure !== null
        ) {
          failures.push(cancellationFailure);
        }
        if (failures.length > 0) {
          throw combinedLifecycleError(
            "Failed to fully release mobile activity monitoring ownership",
            "MOBILE_SIGNAL_NATIVE_RELEASE_FAILED",
            failures,
          );
        }
      })();
      void attempt.then(
        () => {
          if (nativeReleaseTask === releaseTask) {
            nativeReleaseTask = null;
          }
          resolveRelease();
        },
        (error) => {
          if (nativeReleaseTask === releaseTask) {
            nativeReleaseTask = null;
          }
          rejectRelease(error);
        },
      );
    } catch (error) {
      if (nativeReleaseTask === releaseTask) {
        nativeReleaseTask = null;
      }
      rejectRelease(error);
    }
    return releaseTask;
  };

  const hasMonitoringConsent = (status: string): boolean =>
    status === "granted" ||
    status === "determined" ||
    status === "not-applicable";

  const startMobileSignals = async (
    revalidateConsent = false,
  ): Promise<void> => {
    if (
      !mounted ||
      !mobileSignals ||
      typeof mobileSignals.addListener !== "function" ||
      typeof mobileSignals.releaseSignalListeners !== "function" ||
      typeof mobileSignals.checkPermissions !== "function" ||
      typeof mobileSignals.startMonitoring !== "function" ||
      typeof mobileSignals.stopMonitoring !== "function"
    ) {
      return;
    }
    if (mobileSignalsCommitted) {
      if (!revalidateConsent) return;
      // Treat consent as unknown while the OS lookup is pending. The existing
      // native generation stays owned, but its callbacks and poller cannot
      // read or send until the lookup restores the commit bit.
      mobileSignalsCommitted = false;
      let permissions: MobileSignalsPermissionStatus;
      try {
        permissions = await mobileSignals.checkPermissions();
      } catch (error) {
        // error-policy:J6 a permission lookup failure fails closed: release the
        // existing native generation before propagating the lookup failure.
        try {
          await releaseNativeOwnership();
        } catch (cleanupError) {
          // error-policy:J2 preserve both causal failures while adding the
          // lifecycle boundary that could not be established.
          throw combinedLifecycleError(
            "Mobile activity permission revalidation and teardown failed",
            "MOBILE_SIGNAL_PERMISSION_TEARDOWN_FAILED",
            [error, cleanupError],
          );
        }
        throw error;
      }
      if (!mounted) return;
      if (!hasMonitoringConsent(permissions.status)) {
        dispatchLifeOpsActivitySignalsStatus({
          status: "permission_unavailable",
          reason: permissions.status,
        });
        await releaseNativeOwnership();
        return;
      }
      mobileSignalsCommitted = true;
      return;
    }
    if (hasNativeOwnership()) {
      await releaseNativeOwnership();
      if (!mounted) return;
    }

    let committed = false;
    let rollbackStarted = false;
    try {
      if (!mounted) return;
      const permissions = await mobileSignals.checkPermissions();
      if (!mounted) return;
      if (!hasMonitoringConsent(permissions.status)) {
        // Monitoring starts only after the OS records an authorization choice
        // (or reports the capability inapplicable). The settings UI owns
        // prompting; resume re-checks pick up a later choice.
        dispatchLifeOpsActivitySignalsStatus({
          status: "permission_unavailable",
          reason: permissions.status,
        });
        return;
      }

      if (!mounted) return;
      const generation: MobileSignalsGeneration = {
        controller: new AbortController(),
        operations: new Set(),
        refreshTask: null,
      };
      mobileSignalsGeneration = generation;
      // The native callback may be installed before Capacitor resolves the
      // registration promise. Record the package-owned release obligation
      // first so a rejected or lost bridge response remains cleanable.
      mobileSignalListenersNeedRelease = true;
      pendingMobileSignalsHandle = await mobileSignals.addListener(
        "signal",
        (signal: MobileSignalsSignal) => {
          if (!isCurrentMobileSignalsGeneration(generation)) return;
          observeMobileSignalsOperation(generation, () =>
            sendSignal(mapMobileSignal(signal), generation),
          );
        },
      );
      if (!mounted) {
        rollbackStarted = true;
        await releaseNativeOwnership();
        return;
      }

      mobileSignalsStartupAttempted = true;
      // Cancellation is required from the moment native startup is attempted:
      // a bridge rejection can occur after the OS accepted background work.
      mobileBackgroundRefreshNeedsCancel =
        typeof mobileSignals.cancelBackgroundRefresh === "function";
      if (!mounted) {
        rollbackStarted = true;
        await releaseNativeOwnership();
        return;
      }
      const initial = await mobileSignals.startMonitoring({
        emitInitial: true,
      });
      if (!mounted || !initial.enabled) {
        rollbackStarted = true;
        await releaseNativeOwnership();
        return;
      }

      // Commit the handle and monitor as one generation only after native
      // startup succeeds. A rejection or disabled result above is rolled back;
      // any release that fails remains recorded and must succeed on a later
      // retry before another generation can acquire native ownership.
      mobileSignalsHandle = pendingMobileSignalsHandle;
      pendingMobileSignalsHandle = null;
      mobileSignalsStarted = initial.enabled;
      mobileSignalsCommitted = true;
      committed = true;
      clearMobileHealthPoller();
      mobileHealthPoller = window.setInterval(() => {
        if (isCurrentMobileSignalsGeneration(generation)) {
          requestMobileHealthSnapshot("poll", generation);
        }
      }, MOBILE_HEALTH_POLL_MS);

      // Monitoring ownership is already committed; enrichment is observed but
      // cannot pin the acquisition task or suppress later consent checks.
      observeMobileSignalsOperation(generation, () =>
        sendSnapshotResult(initial, generation),
      );
      requestMobileHealthSnapshot("start", generation);
      if (
        typeof mobileSignals.scheduleBackgroundRefresh === "function" &&
        typeof mobileSignals.cancelBackgroundRefresh === "function"
      ) {
        const scheduling = Promise.resolve().then(async () => {
          if (!isCurrentMobileSignalsGeneration(generation)) return;
          const result = await mobileSignals.scheduleBackgroundRefresh();
          if (!isCurrentMobileSignalsGeneration(generation)) return;
          if (!result.scheduled && result.reason) {
            dispatchLifeOpsActivitySignalsStatus({
              status: "background_refresh_unavailable",
              reason: result.reason,
            });
          }
        });
        const ownedScheduling = trackMobileSignalsOperation(
          generation,
          () => scheduling,
        );
        const trackedScheduling = ownedScheduling.finally(() => {
          if (mobileBackgroundRefreshScheduleTask === trackedScheduling) {
            mobileBackgroundRefreshScheduleTask = null;
          }
        });
        mobileBackgroundRefreshScheduleTask = trackedScheduling;
        observeCaptureOperation(trackedScheduling);
      } else if (
        mounted &&
        typeof mobileSignals.scheduleBackgroundRefresh === "function"
      ) {
        // A schedulable job without a cancellation boundary is not ownable.
        dispatchLifeOpsActivitySignalsStatus({
          status: "background_refresh_unavailable",
          reason: "cancel_unavailable",
        });
      }
    } catch (error) {
      // error-policy:J6 a failed partial acquisition is rolled back before the
      // original failure is allowed to cross the controller boundary.
      if (!committed && !rollbackStarted && hasNativeOwnership()) {
        // error-policy:J6 failed acquisition must release every granular
        // obligation before another generation is allowed to start.
        try {
          await releaseNativeOwnership();
        } catch (cleanupError) {
          // error-policy:J2 preserve acquisition and cleanup failures under one
          // classified lifecycle error.
          throw combinedLifecycleError(
            "Mobile activity monitoring startup and rollback failed",
            "MOBILE_SIGNAL_START_ROLLBACK_FAILED",
            [error, cleanupError],
          );
        }
      }
      throw error;
    }
  };

  const requestMobileSignalsStart = (
    revalidateConsent = false,
  ): Promise<void> => {
    if (!mounted) return Promise.resolve();
    if (revalidateConsent) {
      requestedConsentRevalidation += 1;
    }
    if (mobileSignalsStartTask) return mobileSignalsStartTask;

    const runRequestedStarts = async (): Promise<void> => {
      let firstAttempt = true;
      const failures: unknown[] = [];
      while (
        mounted &&
        (firstAttempt ||
          attemptedConsentRevalidation < requestedConsentRevalidation)
      ) {
        const requestedAtStart = requestedConsentRevalidation;
        const mustRevalidate =
          revalidateConsent || attemptedConsentRevalidation < requestedAtStart;
        try {
          await startMobileSignals(mustRevalidate);
        } catch (error) {
          // Keep draining a stronger resume request even if an earlier
          // acquisition failed; the returned task reports every failed attempt.
          failures.push(error);
        }
        if (mustRevalidate) {
          attemptedConsentRevalidation = requestedAtStart;
        }
        firstAttempt = false;
        revalidateConsent = false;
      }
      if (failures.length > 0) {
        throw combinedLifecycleError(
          "One or more mobile activity monitoring start attempts failed",
          "MOBILE_SIGNAL_START_FAILED",
          failures,
        );
      }
    };

    let resolveStart!: () => void;
    let rejectStart!: (error: unknown) => void;
    const startTask = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    // Install the ownership token before runRequestedStarts() can enter
    // checkPermissions(). Native shims may synchronously emit a resume event
    // from that boundary, and the reentrant request must join this generation.
    mobileSignalsStartTask = startTask;
    const running = track(runRequestedStarts());
    void running.then(
      () => {
        if (mobileSignalsStartTask === startTask) {
          mobileSignalsStartTask = null;
        }
        resolveStart();
      },
      (error) => {
        if (mobileSignalsStartTask === startTask) {
          mobileSignalsStartTask = null;
        }
        rejectStart(error);
      },
    );
    return startTask;
  };

  const requestMobileSignalsResume = (): void => {
    if (!mounted) return;
    const startTask = requestMobileSignalsStart(true);
    if (mobileSignalsResumeTask) return;

    const task = startTask
      .then(() => {
        if (mounted && mobileSignalsGeneration) {
          requestMobileHealthSnapshot("resume", mobileSignalsGeneration);
        }
      })
      .finally(() => {
        if (mobileSignalsResumeTask === task) {
          mobileSignalsResumeTask = null;
        }
      });
    mobileSignalsResumeTask = task;
    observeCaptureOperation(task);
  };

  const emitCurrentState = (reason: string): void => {
    if (!mounted) return;
    emitLifecycleState("active");
    emitPageState(reason);
    requestDesktopSnapshot(reason);
    requestMobileHealthSnapshot(reason);
  };

  let runtimeProbeTask: Promise<void> | null = null;
  const requestRuntimeProbe = (
    reason: string,
    onlyWhenBecomingReady: boolean,
  ): void => {
    if (!mounted || runtimeProbeTask) return;
    const wasReady = runtimeReady;
    let resolveProbe!: () => void;
    let rejectProbe!: (error: unknown) => void;
    const probeTask = new Promise<void>((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    // The token precedes getStatus() so a hung transport has one subscriber and
    // cannot make every five-second poll retain another promise chain.
    runtimeProbeTask = probeTask;
    const probing = refreshRuntimeReady().then(async (ready) => {
      if (!mounted || !ready || (onlyWhenBecomingReady && wasReady)) {
        return;
      }
      emitCurrentState(reason);
      await requestMobileSignalsStart();
    });
    void probing.then(
      () => {
        if (runtimeProbeTask === probeTask) {
          runtimeProbeTask = null;
        }
        resolveProbe();
      },
      (error) => {
        if (runtimeProbeTask === probeTask) {
          runtimeProbeTask = null;
        }
        rejectProbe(error);
      },
    );
    observeUnownedProbe(probeTask);
  };

  requestRuntimeProbe("mount", false);

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener(APP_RESUME_EVENT, handleResume);
  document.addEventListener(APP_PAUSE_EVENT, handlePause);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("blur", handleBlur);

  const runtimePoller = window.setInterval(() => {
    requestRuntimeProbe("runtime-ready", true);
  }, RUNTIME_READY_POLL_MS);
  const pageHeartbeat = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      emitPageState("heartbeat");
    }
  }, PAGE_HEARTBEAT_MS);
  const desktopPoller = window.setInterval(() => {
    requestDesktopSnapshot("poll");
  }, DESKTOP_POWER_POLL_MS);

  let stopPromise: Promise<void> | null = null;
  let detachServiceAbort = (): void => {};
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    // Install the shared completion before aborting or entering native
    // teardown. Both boundaries can synchronously re-enter this cleanup.
    stopPromise = completion;
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
    clearMobileHealthPoller();
    window.clearInterval(runtimePoller);
    window.clearInterval(pageHeartbeat);
    window.clearInterval(desktopPoller);

    const initialNativeRelease = releaseNativeOwnership();
    const stopping = (async () => {
      // error-policy:J6 releaseNativeOwnership attempts every owned native
      // resource before rejecting. Failed resources remain recorded so the
      // same idempotent stop can retry instead of permitting duplicate owners.
      const [initialReleaseOutcome] = await Promise.allSettled([
        initialNativeRelease,
        settleInFlight(),
      ]);
      try {
        // A start/getSnapshot task can acquire a handle after the first
        // pagehide sweep. Run a second sweep after every owned task settles.
        await releaseNativeOwnership();
      } catch (finalError) {
        // error-policy:J2 preserve both failed release boundaries so the host
        // can quarantine and retry the same cleanup lease.
        throw initialReleaseOutcome.status === "rejected"
          ? combinedLifecycleError(
              "Failed to stop LifeOps native activity capture after the late-acquisition sweep",
              "MOBILE_SIGNAL_CAPTURE_STOP_FAILED",
              [initialReleaseOutcome.reason, finalError],
            )
          : finalError;
      }
      if (initialReleaseOutcome.status === "rejected") {
        // error-policy:J6 a later sweep established the release postcondition;
        // retain the first failure as teardown diagnostics.
        console.warn(
          `${LOG_PREFIX} native teardown required a successful retry:`,
          initialReleaseOutcome.reason,
        );
      }
    })();
    void stopping.then(
      () => {
        if (activeCaptureStop === stop) {
          activeCaptureStop = null;
        }
        resolveStop();
      },
      (error) => {
        if (stopPromise === completion) {
          stopPromise = null;
        }
        rejectStop(error);
      },
    );
    return completion;
  };

  activeCaptureStop = stop;
  if (serviceSignal) {
    const onServiceAbort = () => {
      const stopping = stop();
      // error-policy:J5 the renderer-service host observes this same cleanup
      // promise and quarantines a failed release; this branch only prevents the
      // synchronous AbortSignal listener from creating an unhandled rejection.
      void stopping.catch(() => {});
    };
    serviceSignal.addEventListener("abort", onServiceAbort, { once: true });
    detachServiceAbort = () =>
      serviceSignal.removeEventListener("abort", onServiceAbort);
    if (serviceSignal.aborted) {
      onServiceAbort();
    }
  }
  return stop;
}

/** True while a capture instance is active — diagnostics/tests only. */
export function isLifeOpsActivitySignalCaptureActive(): boolean {
  return activeCaptureStop !== null;
}
