/**
 * Desktop permission state for the Permissions settings. Loads the full
 * permission snapshot from the API, subscribes to bridge permission events, and
 * reconciles it with renderer-side probes (camera/microphone/location/
 * notifications) whose true grant state the OS layer can't see. Exposes
 * `useDesktopPermissionsState` to the settings UI.
 */

import { logger } from "@elizaos/logger";
import { isPermissionStatus, PERMISSION_IDS } from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AllPermissionsState,
  client,
  type PermissionId,
  type PermissionState,
  type PermissionStatus,
} from "../../api";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { SETTINGS_REFRESH_DELAYS_MS } from "./permission-types";

// ---------------------------------------------------------------------------
// Media permission helpers (renderer-side probing for camera/microphone)
// ---------------------------------------------------------------------------

type RendererPermissionId = Extract<
  PermissionId,
  "camera" | "microphone" | "location" | "notifications"
>;

const RUNTIME_PERMISSION_IDS: readonly PermissionId[] = ["website-blocking"];
const REQUIRED_PERMISSION_IDS: readonly PermissionId[] = PERMISSION_IDS;
const RENDERER_PERMISSION_IDS: readonly RendererPermissionId[] = [
  "camera",
  "microphone",
  "location",
  "notifications",
];
function isRuntimePermissionId(id: PermissionId): boolean {
  return RUNTIME_PERMISSION_IDS.includes(id);
}

function isRendererPermissionId(id: PermissionId): id is RendererPermissionId {
  return (
    id === "camera" ||
    id === "microphone" ||
    id === "location" ||
    id === "notifications"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPermissionState(
  value: unknown,
  id: PermissionId,
): value is PermissionState {
  return (
    isRecord(value) &&
    value.id === id &&
    isPermissionStatus(value.status) &&
    typeof value.canRequest === "boolean" &&
    typeof value.lastChecked === "number"
  );
}

function isAllPermissionsState(value: unknown): value is AllPermissionsState {
  return (
    isRecord(value) &&
    REQUIRED_PERMISSION_IDS.every((id) => isPermissionState(value[id], id))
  );
}

function mapRendererMediaPermissionState(
  state: "granted" | "denied" | "prompt" | "default" | undefined,
): PermissionStatus | null {
  if (state === "granted") {
    return "granted";
  }
  if (state === "denied") {
    return "denied";
  }
  if (state === "prompt" || state === "default") {
    return "not-determined";
  }
  return null;
}

async function queryRendererPermission(
  id: RendererPermissionId,
): Promise<PermissionStatus | null> {
  if (id === "notifications" && typeof Notification !== "undefined") {
    return mapRendererMediaPermissionState(Notification.permission);
  }

  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return null;
  }

  try {
    const result = await navigator.permissions.query({
      name: (id === "location" ? "geolocation" : id) as PermissionName,
    });
    return mapRendererMediaPermissionState(result?.state);
  } catch {
    // error-policy:J3 `null` is the explicit "cannot determine" signal of
    // this probe; callers fall through to the next probe tier.
    return null;
  }
}

async function inferRendererMediaPermissionFromDevices(
  id: Extract<RendererPermissionId, "camera" | "microphone">,
): Promise<PermissionStatus | null> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return null;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!Array.isArray(devices)) {
      return null;
    }

    const kind = id === "camera" ? "videoinput" : "audioinput";
    return devices.some(
      (device) => device.kind === kind && Boolean(device.label?.trim()),
    )
      ? "granted"
      : null;
  } catch {
    // error-policy:J3 `null` is the explicit "cannot determine" signal of
    // this probe; callers fall through to the next probe tier.
    return null;
  }
}

async function probeRendererMediaPermission(
  id: RendererPermissionId,
): Promise<PermissionStatus | null> {
  const queriedStatus = await queryRendererPermission(id);
  if (queriedStatus === "granted" || queriedStatus === "denied") {
    return queriedStatus;
  }

  if (id !== "camera" && id !== "microphone") {
    return queriedStatus;
  }

  const inferredStatus = await inferRendererMediaPermissionFromDevices(id);
  if (inferredStatus) {
    return inferredStatus;
  }

  return queriedStatus;
}

async function requestRendererPermission(
  id: PermissionId,
): Promise<PermissionStatus | null> {
  if (!isRendererPermissionId(id) || typeof navigator === "undefined") {
    return null;
  }

  if (id === "camera" || id === "microphone") {
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({
        video: id === "camera",
        audio: id === "microphone",
      });
      for (const track of stream?.getTracks?.() ?? []) {
        track.stop();
      }
    } catch {
      // error-policy:J4 a rejected getUserMedia is the expected denial shape;
      // the follow-up probe below reports the recorded state.
    }
    return probeRendererMediaPermission(id);
  }

  if (id === "location" && navigator.geolocation) {
    const requestedStatus = await new Promise<PermissionStatus | null>(
      (resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve("granted"),
          (err) =>
            resolve(err.code === err.PERMISSION_DENIED ? "denied" : null),
          { maximumAge: 0, timeout: 10_000 },
        );
      },
    );
    return (await probeRendererMediaPermission(id)) ?? requestedStatus;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    return mapRendererMediaPermissionState(
      await Notification.requestPermission(),
    );
  }

  return probeRendererMediaPermission(id);
}

export interface DesktopPermissionsSnapshot {
  permissions: AllPermissionsState;
  platform: string;
  shellEnabled: boolean;
}

async function reconcileRendererMediaPermissions(
  snapshot: DesktopPermissionsSnapshot,
): Promise<DesktopPermissionsSnapshot> {
  let nextPermissions = snapshot.permissions;
  let changed = false;

  for (const id of RENDERER_PERMISSION_IDS) {
    const current = snapshot.permissions[id];
    if (!current || current.status === "restricted") {
      continue;
    }

    const rendererStatus = await probeRendererMediaPermission(id);
    if (!rendererStatus) {
      continue;
    }

    const nextCanRequest = rendererStatus === "not-determined";
    if (
      current.status === rendererStatus &&
      current.canRequest === nextCanRequest
    ) {
      continue;
    }

    if (!changed) {
      nextPermissions = { ...snapshot.permissions };
      changed = true;
    }

    nextPermissions[id] = {
      ...current,
      status: rendererStatus,
      canRequest: nextCanRequest,
      lastChecked: Date.now(),
    };
  }

  return changed
    ? {
        ...snapshot,
        permissions: nextPermissions,
      }
    : snapshot;
}

async function mergeRuntimePermissionsIntoSnapshot(
  snapshot: DesktopPermissionsSnapshot,
): Promise<DesktopPermissionsSnapshot> {
  let nextPermissions = snapshot.permissions;
  let changed = false;

  await Promise.all(
    RUNTIME_PERMISSION_IDS.map(async (id) => {
      const permission = await client.getPermission(id);
      if (!changed) {
        nextPermissions = { ...snapshot.permissions };
        changed = true;
      }
      nextPermissions[id] = permission;
    }),
  );

  return changed
    ? {
        ...snapshot,
        permissions: nextPermissions,
      }
    : snapshot;
}

// ---------------------------------------------------------------------------
// useDesktopPermissionsState hook
// ---------------------------------------------------------------------------

export function useDesktopPermissionsState() {
  const [permissions, setPermissions] = useState<AllPermissionsState | null>(
    null,
  );
  const [platform, setPlatform] = useState<string>("unknown");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shellEnabled, setShellEnabled] = useState(true);
  const [busyPermissionId, setBusyPermissionId] = useState<PermissionId | null>(
    null,
  );
  const settingsRefreshTimersRef = useRef<number[]>([]);
  const snapshotSequenceRef = useRef(0);
  const lastAppliedSnapshotSequenceRef = useRef(0);
  const operationInFlightRef = useRef<symbol | null>(null);
  const passiveRefreshQueuedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applySnapshot = useCallback((snapshot: DesktopPermissionsSnapshot) => {
    setPermissions(snapshot.permissions);
    setPlatform(snapshot.platform);
    setShellEnabled(snapshot.shellEnabled);
  }, []);

  const clearScheduledSettingsRefreshes = useCallback(() => {
    if (typeof window === "undefined") {
      settingsRefreshTimersRef.current = [];
      return;
    }

    for (const timerId of settingsRefreshTimersRef.current) {
      window.clearTimeout(timerId);
    }
    settingsRefreshTimersRef.current = [];
  }, []);

  const loadPermissionsSnapshot = useCallback(
    async (forceRefresh = false): Promise<DesktopPermissionsSnapshot> => {
      const [bridgedPermissions, bridgedShellEnabled, bridgedPlatform] =
        await Promise.all([
          invokeDesktopBridgeRequest<AllPermissionsState>({
            rpcMethod: "permissionsGetAll",
            ipcChannel: "permissions:getAll",
            params: forceRefresh ? { forceRefresh: true } : undefined,
          }),
          invokeDesktopBridgeRequest<boolean>({
            rpcMethod: "permissionsIsShellEnabled",
            ipcChannel: "permissions:isShellEnabled",
          }),
          invokeDesktopBridgeRequest<string>({
            rpcMethod: "permissionsGetPlatform",
            ipcChannel: "permissions:getPlatform",
          }),
        ]);

      if (forceRefresh && bridgedPermissions === null) {
        await client.refreshPermissions();
      }

      const permissions = bridgedPermissions ?? (await client.getPermissions());
      if (!isAllPermissionsState(permissions)) {
        throw new Error("Invalid permissions payload.");
      }
      const shellEnabled =
        bridgedShellEnabled === null
          ? await client.isShellEnabled()
          : bridgedShellEnabled;

      const snapshot = {
        permissions,
        platform: bridgedPlatform ?? "unknown",
        shellEnabled,
      };
      const runtimeMergedSnapshot =
        await mergeRuntimePermissionsIntoSnapshot(snapshot);
      return reconcileRendererMediaPermissions(runtimeMergedSnapshot);
    },
    [],
  );

  const replaceSnapshot = useCallback(
    async (forceRefresh = false): Promise<DesktopPermissionsSnapshot> => {
      const sequence = ++snapshotSequenceRef.current;
      const snapshot = await loadPermissionsSnapshot(forceRefresh);
      if (
        mountedRef.current &&
        sequence > lastAppliedSnapshotSequenceRef.current
      ) {
        lastAppliedSnapshotSequenceRef.current = sequence;
        applySnapshot(snapshot);
      }
      return snapshot;
    },
    [applySnapshot, loadPermissionsSnapshot],
  );

  const requestPassiveSnapshotRefresh = useCallback(
    async (forceRefresh = true): Promise<DesktopPermissionsSnapshot | null> => {
      if (operationInFlightRef.current) {
        passiveRefreshQueuedRef.current = true;
        return null;
      }
      return replaceSnapshot(forceRefresh);
    },
    [replaceSnapshot],
  );

  const runPermissionOperation = useCallback(
    async (id: PermissionId, operation: () => Promise<void>) => {
      if (operationInFlightRef.current) {
        return null;
      }

      const owner = Symbol(id);
      operationInFlightRef.current = owner;
      // Any snapshot admitted before the OS action began is stale by
      // definition, even if its bridge response arrives after the action.
      lastAppliedSnapshotSequenceRef.current = snapshotSequenceRef.current;
      setBusyPermissionId(id);
      try {
        let operationFailed = false;
        let operationError: unknown;
        try {
          await operation();
        } catch (err) {
          operationFailed = true;
          operationError = err;
        }

        let snapshot: DesktopPermissionsSnapshot | null = null;
        try {
          // This is the single authoritative boundary read for every admitted
          // mutation. It runs even when the native action changed OS state and
          // then rejected its bridge promise.
          snapshot = await replaceSnapshot(true);
        } catch (err) {
          // error-policy:J4 preserve the last confirmed UI state while making
          // a failed post-mutation reconciliation independently observable.
          logger.warn(
            { err, id },
            "[permission-controls] post-operation refresh failed",
          );
          if (!operationFailed) {
            throw err;
          }
        }

        if (operationFailed) {
          throw operationError;
        }
        return snapshot;
      } finally {
        if (operationInFlightRef.current === owner) {
          operationInFlightRef.current = null;
          // Focus/bridge events admitted during the operation are represented
          // by the boundary read above, so they must not launch a duplicate.
          passiveRefreshQueuedRef.current = false;
          if (mountedRef.current) {
            setBusyPermissionId(null);
          }
        }
      }
    },
    [replaceSnapshot],
  );

  const scheduleSettingsRefreshes = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    clearScheduledSettingsRefreshes();

    for (const delayMs of SETTINGS_REFRESH_DELAYS_MS) {
      let timerId = 0;
      timerId = window.setTimeout(() => {
        settingsRefreshTimersRef.current =
          settingsRefreshTimersRef.current.filter(
            (currentTimerId) => currentTimerId !== timerId,
          );
        void requestPassiveSnapshotRefresh(true).catch((err) => {
          // error-policy:J4 keep the last visible snapshot and surface the
          // scheduled reconciliation failure for a later user retry.
          logger.warn(
            { err },
            "[permission-controls] scheduled settings refresh failed",
          );
        });
      }, delayMs);
      settingsRefreshTimersRef.current.push(timerId);
    }
  }, [clearScheduledSettingsRefreshes, requestPassiveSnapshotRefresh]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        await replaceSnapshot();
      } catch (err) {
        // error-policy:J4 the panel renders its designed "unknown platform"
        // state (distinct from granted/denied); warn keeps a broken
        // permission snapshot endpoint observable.
        logger.warn(
          { err },
          "[permission-controls] permission snapshot load failed",
        );
        if (!cancelled) {
          setPermissions(null);
          setPlatform("unknown");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [replaceSnapshot]);

  useEffect(() => {
    return () => {
      clearScheduledSettingsRefreshes();
    };
  }, [clearScheduledSettingsRefreshes]);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "permissionsChanged",
      ipcChannel: "permissions:changed",
      listener: () => {
        void requestPassiveSnapshotRefresh(true).catch((err) => {
          // error-policy:J4 the last visible snapshot stays rendered while the
          // bridge event failure remains observable and retryable on focus.
          logger.warn(
            { err },
            "[permission-controls] permission-change refresh failed",
          );
        });
      },
    });
  }, [requestPassiveSnapshotRefresh]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void requestPassiveSnapshotRefresh(true).catch((err) => {
        // error-policy:J4 focus reconciliation preserves the prior snapshot
        // while logging the failed refresh for the next focus/manual retry.
        logger.warn(
          { err },
          "[permission-controls] focus permission refresh failed",
        );
      });
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    return () => {
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [requestPassiveSnapshotRefresh]);

  const handleRefresh = useCallback(async () => {
    if (operationInFlightRef.current) {
      passiveRefreshQueuedRef.current = true;
      return null;
    }
    setRefreshing(true);
    try {
      return await requestPassiveSnapshotRefresh(true);
    } catch (err) {
      // error-policy:J4 a failed refresh keeps the last-rendered snapshot;
      // warn keeps the failure observable and the user can retry.
      logger.warn({ err }, "[permission-controls] snapshot refresh failed");
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [requestPassiveSnapshotRefresh]);

  const handleRequest = useCallback(
    async (id: PermissionId) => {
      try {
        const snapshot = await runPermissionOperation(id, async () => {
          if (isRuntimePermissionId(id)) {
            await client.requestPermission(id);
            return;
          }

          const bridged = await invokeDesktopBridgeRequest<PermissionState>({
            rpcMethod: "permissionsRequest",
            ipcChannel: "permissions:request",
            params: { id },
          });
          if (isRendererPermissionId(id)) {
            const rendererStatus = await requestRendererPermission(id);
            if (!rendererStatus && bridged === null) {
              await client.requestPermission(id);
            }
          } else if (bridged === null) {
            await client.requestPermission(id);
          }
        });
        const status = snapshot?.permissions[id]?.status;
        if (status && status !== "granted" && status !== "not-applicable") {
          scheduleSettingsRefreshes();
        }
      } catch (err) {
        // error-policy:J4 the boundary snapshot re-renders the authoritative
        // state while the failed request remains observable and retryable.
        logger.warn(
          { err, id },
          "[permission-controls] permission request failed",
        );
      }
    },
    [runPermissionOperation, scheduleSettingsRefreshes],
  );

  const handleOpenSettings = useCallback(
    async (id: PermissionId) => {
      try {
        await runPermissionOperation(id, async () => {
          if (isRuntimePermissionId(id)) {
            await client.openPermissionSettings(id);
            scheduleSettingsRefreshes();
            return;
          }

          const opened = await invokeDesktopBridgeRequest({
            rpcMethod: "permissionsOpenSettings",
            ipcChannel: "permissions:openSettings",
            params: { id },
          });
          if (opened === null) {
            await client.openPermissionSettings(id);
          }
          scheduleSettingsRefreshes();
        });
      } catch (err) {
        // error-policy:J4 the boundary snapshot stays authoritative while the
        // failed settings-open remains observable and retryable.
        logger.warn({ err, id }, "[permission-controls] settings open failed");
      }
    },
    [runPermissionOperation, scheduleSettingsRefreshes],
  );

  const handleToggleShell = useCallback(
    async (enabled: boolean) => {
      try {
        await runPermissionOperation("shell", async () => {
          const bridgeToggle = invokeDesktopBridgeRequest<PermissionState>({
            rpcMethod: "permissionsSetShellEnabled",
            ipcChannel: "permissions:setShellEnabled",
            params: { enabled },
          });
          const outcomes = await Promise.allSettled([
            bridgeToggle,
            client.setShellEnabled(enabled),
          ]);
          const failures = outcomes.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              "One or more shell permission mutations failed",
            );
          }
        });
      } catch (err) {
        // error-policy:J4 the boundary refresh confirms the rendered switch
        // while the failed mutation remains observable and retryable.
        logger.warn(
          { err, enabled },
          "[permission-controls] shell permission toggle failed",
        );
      }
    },
    [runPermissionOperation],
  );

  return {
    busyPermissionId,
    handleOpenSettings,
    handleRefresh,
    handleRequest,
    handleToggleShell,
    loading,
    permissions,
    platform,
    refreshing,
    shellEnabled,
  };
}
