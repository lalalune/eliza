/**
 * Settings → Permissions section (the `permissions` section id). Lists the OS-
 * level permissions the agent depends on (from SYSTEM_PERMISSIONS/CAPABILITIES),
 * shows each one's granted/denied status, and requests or reconciles them across
 * platforms — mobile via the native mobile-signals plugin, desktop via the
 * bridge. Also hosts the permission-priming card.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PermissionId, PermissionState } from "../../api";
import {
  getMobileSignalsPlugin,
  type MobileSignalsPermissionStatus,
  type MobileSignalsSetupAction,
} from "../../bridge/native-plugins";
import { useBootConfig } from "../../config/boot-config-react.hooks";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import {
  isDesktopPlatform,
  isNative,
  isWebPlatform,
  platform as runtimePlatform,
} from "../../platform";
import {
  checkMobileSignalsPermissions,
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
  openMobileSignalsSettings,
  requestMobileSignalsPermissions,
} from "../../platform/mobile-permissions-client";
import { useAppSelector } from "../../state";
import { PermissionPrimingModal } from "../permissions/PermissionPrimingModal";
import { resolvePrimingSet } from "../permissions/permission-priming";
import { StreamingPermissionsSettingsView } from "../permissions/StreamingPermissions";
import { CapabilityToggle, PermissionRow } from "./permission-controls";
import { useDesktopPermissionsState } from "./permission-controls.hooks";
import {
  CAPABILITIES,
  SYSTEM_PERMISSIONS,
  translateWithFallback,
} from "./permission-types";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

type WebsiteBlockerSettingsCardComponent = NonNullable<
  ReturnType<typeof useBootConfig>["websiteBlockerSettingsCard"]
>;

// Per-platform description / grant-note strings, keyed by platform.
type DesktopPlatform = "darwin" | "win32" | "linux";

interface PlatformCopy {
  grantNote: { key: string; defaultValue: string };
}

const PLATFORM_COPY: Record<DesktopPlatform, PlatformCopy> = {
  darwin: {
    grantNote: {
      key: "permissionssection.MacGrantAccessNote",
      defaultValue:
        "macOS requires Accessibility permission for computer control. Open System Settings → Privacy & Security to grant access.",
    },
  },
  win32: {
    grantNote: {
      key: "permissionssection.WindowsGrantPermissionsNote",
      defaultValue:
        "Windows may not list this app by name here. Use Privacy settings to enable microphone and camera access, then test them in the app.",
    },
  },
  linux: {
    grantNote: {
      key: "permissionssection.GrantPermissionsNote",
      defaultValue:
        "Grant permissions to enable features like voice input and computer control.",
    },
  },
};

function platformCopy(platform: string | null | undefined): PlatformCopy {
  if (platform === "darwin") return PLATFORM_COPY.darwin;
  if (platform === "win32") return PLATFORM_COPY.win32;
  return PLATFORM_COPY.linux;
}

/* ── Streaming permission views (mobile / web) ──────────────────── */

function MobilePermissionsView() {
  const t = useAppSelector((s) => s.t);
  const {
    appBlockerSettingsCard: AppBlockerSettingsCard,
    websiteBlockerSettingsCard: WebsiteBlockerSettingsCard,
  } = useBootConfig();
  return (
    <SettingsStack>
      <StreamingPermissionsSettingsView
        mode="mobile"
        testId="mobile-permissions"
        title={t("permissionssection.StreamingPermissions", {
          defaultValue: "Streaming Permissions",
        })}
      />
      <MobileSystemPermissionsPanel />
      <MobileSignalsPermissionsPanel />
      {AppBlockerSettingsCard ? <AppBlockerSettingsCard mode="mobile" /> : null}
      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard mode="mobile" />
      ) : null}
    </SettingsStack>
  );
}

function mobileSettingsPlatform(): "ios" | "android" | "web" {
  if (runtimePlatform === "ios" || runtimePlatform === "android") {
    return runtimePlatform;
  }
  return "web";
}

type MobilePermissionOperation = "check" | "request" | "settings";

function mobilePermissionErrorMessage(
  operation: MobilePermissionOperation,
): string {
  if (operation === "request") {
    return "The permission request failed before the OS confirmed a result. Retry to read the current state.";
  }
  if (operation === "settings") {
    return "Settings could not be opened. Retry or open the app's permission settings manually.";
  }
  return "The current permission state could not be read. Retry to check again.";
}

export function MobileSystemPermissionsPanel() {
  const t = useAppSelector((s) => s.t);
  const branding = useBranding();
  const mobilePlatform = mobileSettingsPlatform();
  const registry = useMemo(() => createMobileSignalsPermissionsRegistry(), []);
  const permissionDefs = useMemo(
    () =>
      SYSTEM_PERMISSIONS.filter((def) =>
        def.platforms.includes(mobilePlatform),
      ),
    [mobilePlatform],
  );
  const [states, setStates] = useState<
    Partial<Record<PermissionId, PermissionState>>
  >({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<PermissionId | null>(null);
  const [errors, setErrors] = useState<
    Partial<Record<PermissionId, MobilePermissionOperation>>
  >({});
  const operationInFlightRef = useRef(false);

  const checkPermissions = useCallback(async () => {
    const results = await Promise.all(
      permissionDefs.map(async (def) => {
        try {
          return {
            id: def.id,
            state: await registry.check(def.id),
          } as const;
        } catch {
          // error-policy:J4 a failed native probe is rendered as an error row;
          // cached defaults must not masquerade as a promptable OS state.
          return { id: def.id, error: "check" as const };
        }
      }),
    );
    const nextStates: Partial<Record<PermissionId, PermissionState>> = {};
    const nextErrors: Partial<Record<PermissionId, MobilePermissionOperation>> =
      {};
    for (const result of results) {
      if ("state" in result) {
        nextStates[result.id] = result.state;
      } else {
        nextErrors[result.id] = result.error;
      }
    }
    return { states: nextStates, errors: nextErrors };
  }, [permissionDefs, registry]);

  const applyPermissionCheck = useCallback(async () => {
    const next = await checkPermissions();
    setStates(next.states);
    setErrors(next.errors);
  }, [checkPermissions]);

  const refresh = useCallback(async () => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setRefreshing(true);
    try {
      await applyPermissionCheck();
    } finally {
      operationInFlightRef.current = false;
      setRefreshing(false);
    }
  }, [applyPermissionCheck]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const next = await checkPermissions();
        if (!cancelled) {
          setStates(next.states);
          setErrors(next.errors);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkPermissions]);

  const recordError = useCallback(
    (id: PermissionId, operation: MobilePermissionOperation) => {
      setStates((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setErrors((current) => ({ ...current, [id]: operation }));
    },
    [],
  );

  const requestPermission = useCallback(
    async (id: PermissionId) => {
      if (operationInFlightRef.current) return;
      operationInFlightRef.current = true;
      setBusyId(id);
      try {
        await registry.request(id, {
          reason: "Enable this permission from Settings.",
          feature: { app: "settings", action: `permissions.${id}` },
        });
        await applyPermissionCheck();
      } catch {
        // error-policy:J4 request transport/native failures remain distinct
        // from a denied permission result and expose the row's retry control.
        recordError(id, "request");
      } finally {
        operationInFlightRef.current = false;
        setBusyId(null);
      }
    },
    [applyPermissionCheck, recordError, registry],
  );

  const openSettings = useCallback(
    async (id: PermissionId) => {
      if (operationInFlightRef.current) return;
      operationInFlightRef.current = true;
      setBusyId(id);
      try {
        const result = await openMobilePermissionSettings(id);
        if (result?.opened !== true) {
          recordError(id, "settings");
          return;
        }
        await applyPermissionCheck();
      } catch {
        // error-policy:J4 settings-navigation failures are visible and
        // retryable; they are not converted into a permission state.
        recordError(id, "settings");
      } finally {
        operationInFlightRef.current = false;
        setBusyId(null);
      }
    },
    [applyPermissionCheck, recordError],
  );

  const retryPermission = useCallback(
    async (id: PermissionId) => {
      if (operationInFlightRef.current) return;
      operationInFlightRef.current = true;
      setBusyId(id);
      try {
        const next = await registry.check(id);
        setStates((current) => ({ ...current, [id]: next }));
        setErrors((current) => {
          const updated = { ...current };
          delete updated[id];
          return updated;
        });
      } catch {
        // error-policy:J4 preserve the explicit row error when a retry fails.
        recordError(id, "check");
      } finally {
        operationInFlightRef.current = false;
        setBusyId(null);
      }
    },
    [recordError, registry],
  );

  if (permissionDefs.length === 0) return null;

  if (loading) {
    return (
      <p className="py-4 text-center text-xs text-muted">
        {t("permissionssection.LoadingPermissions", {
          defaultValue: "Loading permissions...",
        })}
      </p>
    );
  }

  return (
    <SettingsGroup
      title={t("permissionssection.SystemPermissions", {
        defaultValue: "System Permissions",
      })}
      action={
        <SettingsActionButton
          agentId="perm-mobile-system-refresh"
          agentLabel="Refresh mobile system permissions"
          agentGroup="permissions"
          agentStatus={refreshing ? "loading" : undefined}
          variant="outline"
          size="sm"
          className="h-9 rounded-sm px-3 text-xs font-semibold"
          onClick={() => void refresh()}
          disabled={refreshing || busyId !== null}
        >
          {refreshing
            ? t("common.refreshing", { defaultValue: "Refreshing..." })
            : t("common.refresh", { defaultValue: "Refresh" })}
        </SettingsActionButton>
      }
      footer={t("permissionssection.MobilePermissionGrantNote", {
        defaultValue:
          "If a permission was denied, open Settings and enable it for {{appName}}, then return here and refresh.",
        ...appNameInterpolationVars(branding),
      })}
    >
      {permissionDefs.map((def) => {
        const operationError = errors[def.id];
        const state = states[def.id];
        if (operationError || !state) {
          const name = translateWithFallback(t, def.nameKey, def.name);
          return (
            <SettingsRow
              key={def.id}
              tone="danger"
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {name}
                  <span className="rounded-full border border-danger/30 px-2 py-0.5 text-xs font-medium text-danger">
                    Check failed
                  </span>
                </span>
              }
              description={
                <span
                  role="alert"
                  data-testid={`mobile-permission-error-${def.id}`}
                >
                  {mobilePermissionErrorMessage(operationError ?? "check")}
                </span>
              }
              control={
                <SettingsActionButton
                  agentId={`perm-mobile-system-retry-${def.id}`}
                  agentLabel={`Retry ${name} permission check`}
                  agentGroup="permissions"
                  variant="outline"
                  size="sm"
                  className="min-h-11 rounded-sm px-3 text-xs font-semibold"
                  onClick={() => void retryPermission(def.id)}
                  disabled={busyId !== null}
                >
                  {busyId === def.id ? "Checking..." : "Retry"}
                </SettingsActionButton>
              }
            />
          );
        }
        return (
          <PermissionRow
            key={def.id}
            def={def}
            status={state.status}
            reason={busyId === def.id ? "Updating..." : state.reason}
            platform={mobilePlatform}
            canRequest={state.canRequest}
            onRequest={() => void requestPermission(def.id)}
            onOpenSettings={() => void openSettings(def.id)}
            disabled={busyId !== null}
            isShell={false}
            shellEnabled
          />
        );
      })}
    </SettingsGroup>
  );
}

function mobileSetupActionTarget(action: MobileSignalsSetupAction) {
  if (action.settingsTarget) return action.settingsTarget;
  if (action.id === "health_permissions") return "health";
  if (action.id === "screen_time_authorization") return "screenTime";
  if (action.id === "android_usage_access") return "usageAccess";
  if (action.id === "notification_settings") return "notification";
  if (action.id === "battery_optimization") return "batteryOptimization";
  if (action.id === "local_network") return "localNetwork";
  return "app";
}

function mobileSetupRequestTarget(action: MobileSignalsSetupAction) {
  if (action.id === "health_permissions") return "health";
  if (action.id === "screen_time_authorization") return "screenTime";
  if (action.id === "notification_settings") return "notifications";
  return "all";
}

function mobileSetupPermissionId(
  action: MobileSignalsSetupAction,
): PermissionId {
  if (action.id === "health_permissions") return "health";
  if (action.id === "screen_time_authorization") return "screentime";
  if (action.id === "android_usage_access") return "usage-access";
  if (action.id === "notification_settings") return "notifications";
  if (action.id === "battery_optimization") return "battery-optimization";
  if (action.id === "local_network") return "local-network";
  return "health";
}

function mobileSetupActionBadge(
  action: MobileSignalsSetupAction,
  choicesAreOpaque: boolean,
) {
  if (choicesAreOpaque) {
    return { label: "Choices set", className: "border-border/50 text-muted" };
  }
  if (action.status === "ready") {
    return { label: "Ready", className: "border-ok/30 text-ok" };
  }
  if (action.status === "unavailable") {
    return { label: "Unavailable", className: "border-border/50 text-muted" };
  }
  return { label: "Needs action", className: "border-warn/30 text-warn" };
}

// Exported for tests: the error-vs-designed-hidden distinction below is a
// three-state-rule guard (#12784) and needs direct render coverage.
export function MobileSignalsPermissionsPanel() {
  const t = useAppSelector((s) => s.t);
  const [status, setStatus] = useState<MobileSignalsPermissionStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  // A thrown checkPermissions (plugin present but broken) must render as an
  // error, not vanish like the designed "plugin not on this platform" degrade
  // (three-state rule: error vs designed-hidden must be distinguishable).
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const operationInFlightRef = useRef(false);

  const loadStatus = useCallback(async () => {
    const plugin = getMobileSignalsPlugin();
    if (typeof plugin.checkPermissions !== "function") {
      setStatus(null);
      setError(false);
      return;
    }
    try {
      const next = await checkMobileSignalsPermissions(plugin);
      setStatus(next ?? null);
      setError(false);
      setActionError(null);
    } catch {
      // error-policy:J4 bridge call failed — surface the explicit error row
      // below instead of silently hiding the whole panel.
      setStatus(null);
      setError(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setRefreshing(true);
    try {
      await loadStatus();
    } finally {
      operationInFlightRef.current = false;
      setRefreshing(false);
    }
  }, [loadStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const plugin = getMobileSignalsPlugin();
        if (typeof plugin.checkPermissions !== "function") {
          // Designed degrade: the mobile-signals plugin isn't part of this
          // build (web/desktop), so the panel intentionally renders nothing.
          if (!cancelled) setStatus(null);
          return;
        }
        const next = await checkMobileSignalsPermissions(plugin);
        if (!cancelled) {
          setStatus(next ?? null);
          setError(false);
        }
      } catch {
        // error-policy:J4 plugin exists but the permissions probe failed —
        // render the explicit error row, not the designed-hidden state.
        if (!cancelled) {
          setStatus(null);
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAction = useCallback(
    async (action: MobileSignalsSetupAction, manageOpaqueChoices: boolean) => {
      if (operationInFlightRef.current) return;
      operationInFlightRef.current = true;
      const plugin = getMobileSignalsPlugin();
      const permissionId = mobileSetupPermissionId(action);
      setBusyAction(action.id);
      setActionError(null);
      try {
        if (manageOpaqueChoices && action.canOpenSettings) {
          const result = await openMobileSignalsSettings(
            permissionId,
            mobileSetupActionTarget(action),
            plugin,
          );
          if (result?.opened !== true) {
            setActionError(action.label);
            return;
          }
        } else if (
          action.canRequest &&
          (action.id === "health_permissions" ||
            action.id === "screen_time_authorization" ||
            action.id === "notification_settings") &&
          typeof plugin.requestPermissions === "function"
        ) {
          await requestMobileSignalsPermissions(
            permissionId,
            mobileSetupRequestTarget(action),
            plugin,
          );
        } else if (
          action.canOpenSettings &&
          typeof plugin.openSettings === "function"
        ) {
          const result = await openMobileSignalsSettings(
            permissionId,
            mobileSetupActionTarget(action),
            plugin,
          );
          if (result?.opened !== true) {
            setActionError(action.label);
            return;
          }
        }
        await loadStatus();
      } catch {
        // error-policy:J4 a failed request/settings action remains visible on
        // the panel and can be retried from the unchanged action row.
        setActionError(action.label);
      } finally {
        operationInFlightRef.current = false;
        setBusyAction(null);
      }
    },
    [loadStatus],
  );

  if (loading) {
    return (
      <p className="py-4 text-center text-xs text-muted">
        {t("permissionssection.LoadingPermissions", {
          defaultValue: "Loading permissions...",
        })}
      </p>
    );
  }

  if (!status) {
    if (error) {
      return (
        <SettingsGroup
          title={t("permissionssection.LifeOpsSignals", {
            defaultValue: "LifeOps Signals",
          })}
        >
          <SettingsRow
            tone="danger"
            label={t("permissionssection.PermissionsUnavailable", {
              defaultValue: "Device permissions unavailable",
            })}
            description={
              <span role="alert" data-testid="mobile-signals-permissions-error">
                {t("permissionssection.PermissionsError", {
                  defaultValue: "Could not read device permissions.",
                })}
              </span>
            }
            control={
              <SettingsActionButton
                agentId="perm-mobile-signals-retry"
                agentLabel="Retry mobile signals permission check"
                agentGroup="permissions"
                variant="outline"
                size="sm"
                className="min-h-11 rounded-sm px-3 text-xs font-semibold"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                {refreshing
                  ? t("common.retrying", { defaultValue: "Retrying..." })
                  : t("common.retry", { defaultValue: "Retry" })}
              </SettingsActionButton>
            }
          />
        </SettingsGroup>
      );
    }
    return null;
  }

  return (
    <SettingsGroup
      title={t("permissionssection.LifeOpsSignals", {
        defaultValue: "LifeOps Signals",
      })}
      action={
        <SettingsActionButton
          agentId="perm-mobile-signals-refresh"
          agentLabel="Refresh mobile signals"
          agentGroup="permissions"
          variant="outline"
          size="sm"
          className="h-9 rounded-sm px-3 text-xs font-semibold"
          onClick={refresh}
          disabled={refreshing || busyAction !== null}
        >
          {refreshing
            ? t("common.refreshing", { defaultValue: "Refreshing..." })
            : t("common.refresh", { defaultValue: "Refresh" })}
        </SettingsActionButton>
      }
    >
      {actionError ? (
        <p
          role="alert"
          data-testid="mobile-signals-action-error"
          className="py-2 text-xs text-danger"
        >
          Could not update {actionError}. Try again.
        </p>
      ) : null}
      {status.setupActions.map((action) => {
        const choicesAreOpaque =
          status.status === "determined" && action.id === "health_permissions";
        return (
          <MobileSetupActionRow
            key={action.id}
            action={action}
            choicesAreOpaque={choicesAreOpaque}
            busy={busyAction !== null || refreshing}
            onAct={() => void handleAction(action, choicesAreOpaque)}
          />
        );
      })}
    </SettingsGroup>
  );
}

function MobileSetupActionRow({
  action,
  choicesAreOpaque,
  busy,
  onAct,
}: {
  action: MobileSignalsSetupAction;
  choicesAreOpaque: boolean;
  busy: boolean;
  onAct: () => void;
}) {
  const t = useAppSelector((s) => s.t);
  const badge = mobileSetupActionBadge(action, choicesAreOpaque);
  const canAct = choicesAreOpaque
    ? action.canOpenSettings
    : action.status !== "ready" &&
      (action.canRequest || action.canOpenSettings);
  const actionLabel = choicesAreOpaque
    ? t("permissionssection.Manage", { defaultValue: "Manage" })
    : action.canRequest
      ? t("permissionssection.Grant", { defaultValue: "Grant" })
      : t("permissionssection.OpenSettings", { defaultValue: "Open Settings" });
  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-center gap-2">
          {action.label}
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}
          >
            {badge.label}
          </span>
        </span>
      }
      description={
        choicesAreOpaque
          ? "iOS keeps individual HealthKit read choices private. Monitoring can query only the data you allowed."
          : (action.reason ?? undefined)
      }
      control={
        canAct ? (
          <SettingsActionButton
            agentId={`perm-mobile-action-${action.id}`}
            agentLabel={`${actionLabel} ${action.label}`}
            agentGroup="permissions"
            variant="default"
            size="sm"
            className="min-h-11 rounded-sm px-3 text-xs font-semibold"
            disabled={busy}
            onClick={onAct}
          >
            {busy
              ? t("common.loading", { defaultValue: "Loading..." })
              : actionLabel}
          </SettingsActionButton>
        ) : undefined
      }
    />
  );
}

function WebPermissionsView() {
  const t = useAppSelector((s) => s.t);
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
  return (
    <SettingsStack>
      <StreamingPermissionsSettingsView
        mode="web"
        testId="web-permissions-info"
        title={t("permissionssection.BrowserPermissions", {
          defaultValue: "Browser Permissions",
        })}
      />
      {WebsiteBlockerSettingsCard ? (
        isLocalBrowserRuntime() ? (
          <LocalWebsiteBlockingCard
            WebsiteBlockerSettingsCard={WebsiteBlockerSettingsCard}
          />
        ) : (
          <WebsiteBlockerSettingsCard mode="web" />
        )
      ) : null}
    </SettingsStack>
  );
}

function isLocalBrowserRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname.toLowerCase();
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function LocalWebsiteBlockingCard({
  WebsiteBlockerSettingsCard,
}: {
  WebsiteBlockerSettingsCard: WebsiteBlockerSettingsCardComponent;
}) {
  const { handleOpenSettings, handleRequest, loading, permissions, platform } =
    useDesktopPermissionsState();

  if (loading) {
    return (
      <p className="py-4 text-center text-xs text-muted">
        Loading website blocking...
      </p>
    );
  }

  if (!permissions) {
    return <WebsiteBlockerSettingsCard mode="web" />;
  }

  return (
    <WebsiteBlockerSettingsCard
      mode="desktop"
      permission={permissions["website-blocking"]}
      platform={platform}
      onRequestPermission={() => handleRequest("website-blocking")}
      onOpenPermissionSettings={() => handleOpenSettings("website-blocking")}
    />
  );
}

/* ── Desktop permission view ────────────────────────────────────── */

function DesktopPermissionsView() {
  const t = useAppSelector((s) => s.t);
  const plugins = useAppSelector((s) => s.plugins);
  const handlePluginToggle = useAppSelector((s) => s.handlePluginToggle);
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
  const {
    busyPermissionId,
    handleOpenSettings,
    handleRequest,
    handleToggleShell,
    loading,
    permissions,
    platform,
    shellEnabled,
  } = useDesktopPermissionsState();

  const arePermissionsGranted = useCallback(
    (requiredPerms: PermissionId[]): boolean => {
      if (!permissions) return false;
      return requiredPerms.every((id) => {
        const state = permissions[id];
        return (
          state?.status === "granted" || state?.status === "not-applicable"
        );
      });
    },
    [permissions],
  );

  const applicablePermissions = useMemo(
    () =>
      SYSTEM_PERMISSIONS.filter((def) => {
        if (!permissions) return true;
        const state = permissions[def.id];
        return state?.status !== "not-applicable";
      }),
    [permissions],
  );

  if (loading) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        {t("permissionssection.LoadingPermissions", {
          defaultValue: "Loading permissions...",
        })}
      </p>
    );
  }

  if (!permissions) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        {t("permissionssection.UnableToLoadPermi", {
          defaultValue: "Unable to load permissions.",
        })}
      </p>
    );
  }

  const copy = platformCopy(platform);

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("permissionssection.SystemPermissions", {
          defaultValue: "System Permissions",
        })}
        footer={t(copy.grantNote.key, {
          defaultValue: copy.grantNote.defaultValue,
        })}
      >
        {applicablePermissions.map((def) => {
          const state = permissions[def.id];
          return (
            <PermissionRow
              key={def.id}
              def={def}
              status={state?.status ?? "not-determined"}
              reason={state?.reason}
              platform={platform}
              canRequest={state?.canRequest ?? false}
              onRequest={() => handleRequest(def.id)}
              onOpenSettings={() => handleOpenSettings(def.id)}
              disabled={busyPermissionId !== null}
              isShell={def.id === "shell"}
              shellEnabled={shellEnabled}
              onToggleShell={def.id === "shell" ? handleToggleShell : undefined}
            />
          );
        })}
      </SettingsGroup>

      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard
          mode="desktop"
          permission={permissions["website-blocking"]}
          platform={platform}
          onRequestPermission={() => handleRequest("website-blocking")}
          onOpenPermissionSettings={() =>
            handleOpenSettings("website-blocking")
          }
        />
      ) : null}

      <SettingsGroup title={t("common.capabilities")}>
        {CAPABILITIES.map((cap) => {
          const plugin = plugins.find((p) => p.id === cap.id) ?? null;
          const permissionsGranted = arePermissionsGranted(
            cap.requiredPermissions,
          );
          return (
            <CapabilityToggle
              key={cap.id}
              cap={cap}
              plugin={plugin}
              permissionsGranted={permissionsGranted}
              onToggle={(enabled) => {
                if (plugin) void handlePluginToggle(cap.id, enabled);
              }}
            />
          );
        })}
      </SettingsGroup>
    </SettingsStack>
  );
}

/**
 * Re-trigger for the onboarding permission-priming modal. Lets a user who
 * declined or mis-tapped a permission during onboarding re-run the guided
 * soft-ask flow at any time. Renders nothing on platforms with no priming set
 * (web), where every permission is requested just-in-time instead.
 */
function PermissionPrimingSettingsCard() {
  const t = useAppSelector((s) => s.t);
  const branding = useBranding();
  const ids = useMemo(() => resolvePrimingSet(), []);
  const [open, setOpen] = useState(false);

  if (ids.length === 0) return null;

  return (
    <SettingsGroup
      title={t("permissionssection.QuickSetup", {
        defaultValue: "Quick setup",
      })}
      footer={t("permissionssection.QuickSetupNote", {
        defaultValue:
          "Walk through the key permissions ({{appName}} voice, location, notifications) with an explanation for each.",
        ...appNameInterpolationVars(branding),
      })}
    >
      <SettingsRow
        label={t("permissionssection.SetUpPermissions", {
          defaultValue: "Set up permissions",
        })}
        description={t("permissionssection.SetUpPermissionsDesc", {
          defaultValue:
            "Re-run the guided permission prompts, including any you previously declined.",
        })}
        control={
          <SettingsActionButton
            agentId="perm-priming-open"
            agentLabel="Set up permissions"
            agentGroup="permissions"
            variant="default"
            size="sm"
            className="min-h-11 rounded-sm px-3 text-xs font-semibold"
            onClick={() => setOpen(true)}
          >
            {t("permissionssection.Review", { defaultValue: "Review" })}
          </SettingsActionButton>
        }
      />
      {open ? (
        <PermissionPrimingModal
          ids={ids}
          open={open}
          onComplete={() => setOpen(false)}
        />
      ) : null}
    </SettingsGroup>
  );
}

function PermissionsSectionBody() {
  if (isWebPlatform()) return <WebPermissionsView />;
  if (isNative && !isDesktopPlatform()) return <MobilePermissionsView />;
  return <DesktopPermissionsView />;
}

export function PermissionsSection() {
  return (
    <SettingsStack>
      <PermissionPrimingSettingsCard />
      <PermissionsSectionBody />
    </SettingsStack>
  );
}
