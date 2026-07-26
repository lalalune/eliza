/**
 * In-chat card the agent renders when an action needs an OS permission
 * (reminders, screen-recording, …): explains why, requests it through the
 * injected permissions registry, tracks the resulting state, and offers a
 * fallback or an open-settings path when the permission is denied. When no
 * registry is supplied it renders a passive not-determined state so it still
 * shows in stories/tests. Label copy and helpers live in
 * permission-card.helpers.
 */
import {
  type IPermissionsRegistry,
  openPermissionSettings,
  type PermissionId,
  type PermissionState,
} from "@elizaos/shared";
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useBranding } from "../../../config/branding";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  defaultStateFor,
  getPermissionLabel,
  type PermissionCardFallbackChoice,
  type PermissionCardLabels,
  parseFeatureRef,
} from "./permission-card.helpers";

export interface PermissionCardProps {
  permission: PermissionId;
  reason: string;
  feature: string;
  fallbackOffered?: boolean;
  fallbackLabel?: string;
  /**
   * Permissions registry. When omitted, the card falls back to a passive
   * `not-determined` rendering so it still renders in stories/tests without
   * a wired runtime.
   */
  registry?: IPermissionsRegistry;
  /** Initial state override for tests / SSR. */
  initialState?: PermissionState;
  /** Called when the user dismisses the card. */
  onDismiss?: () => void;
  /** Called when the user picks the fallback option. */
  onFallback?: (choice: PermissionCardFallbackChoice) => void;
  /** Called once the registry reports `granted`. The agent uses this to
   *  retry the original action. */
  onGranted?: (state: PermissionState) => void;
  /** Opens OS settings for denied permissions that cannot be requested again. */
  onOpenSettings?: (permission: PermissionId) => unknown | Promise<unknown>;
  labels?: PermissionCardLabels;
  className?: string;
}

type PermissionCardOperation = "check" | "request" | "settings";

export function PermissionCard({
  permission,
  reason,
  feature,
  fallbackOffered = false,
  fallbackLabel,
  registry,
  initialState,
  onDismiss,
  onFallback,
  onGranted,
  onOpenSettings,
  labels = {},
  className,
}: PermissionCardProps): React.ReactElement | null {
  const { appName } = useBranding();
  const [state, setState] = useState<PermissionState>(
    initialState ?? registry?.get(permission) ?? defaultStateFor(permission),
  );
  const [requesting, setRequesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [operationError, setOperationError] =
    useState<PermissionCardOperation | null>(null);
  const operationEpochRef = useRef(0);
  const operationInFlightRef = useRef<symbol | null>(null);

  useEffect(
    () => () => {
      operationEpochRef.current += 1;
      operationInFlightRef.current = null;
    },
    [],
  );

  const beginOperation = useCallback((kind: PermissionCardOperation) => {
    if (operationInFlightRef.current) return null;
    const token = Symbol(kind);
    operationInFlightRef.current = token;
    const epoch = ++operationEpochRef.current;
    if (kind === "request") setRequesting(true);
    if (kind === "check") setChecking(true);
    if (kind === "settings") setOpeningSettings(true);
    setOperationError(null);
    return { token, epoch };
  }, []);

  const ownsOperation = useCallback(
    (operation: { token: symbol; epoch: number }) =>
      operationInFlightRef.current === operation.token &&
      operationEpochRef.current === operation.epoch,
    [],
  );

  const finishOperation = useCallback(
    (
      operation: { token: symbol; epoch: number },
      kind: PermissionCardOperation,
    ) => {
      if (operationInFlightRef.current !== operation.token) return;
      operationInFlightRef.current = null;
      if (kind === "request") setRequesting(false);
      if (kind === "check") setChecking(false);
      if (kind === "settings") setOpeningSettings(false);
    },
    [],
  );

  const handleGrant = useCallback(async () => {
    if (!registry) return;
    const operation = beginOperation("request");
    if (!operation) return;
    try {
      const next = await registry.request(permission, {
        reason,
        feature: parseFeatureRef(feature),
      });
      if (!ownsOperation(operation)) return;
      setState(next);
      if (next.status === "granted") {
        onGranted?.(next);
      }
    } catch {
      // error-policy:J4 a failed request remains visible and retryable instead
      // of leaving the card looking like the OS rejected the permission.
      if (!ownsOperation(operation)) return;
      setOperationError("request");
    } finally {
      finishOperation(operation, "request");
    }
  }, [
    beginOperation,
    feature,
    finishOperation,
    onGranted,
    ownsOperation,
    permission,
    reason,
    registry,
  ]);

  const handleCheckAgain = useCallback(async () => {
    if (!registry) return;
    const operation = beginOperation("check");
    if (!operation) return;
    try {
      const next = await registry.check(permission);
      if (!ownsOperation(operation)) return;
      setState(next);
      if (next.status === "granted") {
        onGranted?.(next);
      }
    } catch {
      // error-policy:J4 a failed probe is a distinct user-facing error, not a
      // permission result, and the same control can retry it.
      if (!ownsOperation(operation)) return;
      setOperationError("check");
    } finally {
      finishOperation(operation, "check");
    }
  }, [
    beginOperation,
    finishOperation,
    onGranted,
    ownsOperation,
    permission,
    registry,
  ]);

  const handleOpenSettings = useCallback(async () => {
    const operation = beginOperation("settings");
    if (!operation) return;
    try {
      if (onOpenSettings) {
        const result = await onOpenSettings(permission);
        if (!ownsOperation(operation)) return;
        if (settingsOpenFailed(result)) {
          setOperationError("settings");
        }
        return;
      }
      await openPermissionSettings(permission);
    } catch {
      // error-policy:J4 settings navigation failures need a visible retry path
      // because opening settings is the only recovery for some OS states.
      if (!ownsOperation(operation)) return;
      setOperationError("settings");
    } finally {
      finishOperation(operation, "settings");
    }
  }, [
    beginOperation,
    finishOperation,
    onOpenSettings,
    ownsOperation,
    permission,
  ]);

  const handleDismiss = useCallback(() => {
    operationEpochRef.current += 1;
    setDismissed(true);
    onDismiss?.();
  }, [onDismiss]);

  const handleFallback = useCallback(() => {
    operationEpochRef.current += 1;
    onFallback?.({ type: "use_fallback", feature, permission });
    setDismissed(true);
  }, [onFallback, feature, permission]);

  useEffect(() => {
    if (!registry) return;
    let cancelled = false;
    const operation = beginOperation("check");
    if (operation) {
      void registry
        .check(permission)
        .then((next) => {
          if (!cancelled && ownsOperation(operation)) {
            setState(next);
            setOperationError(null);
          }
        })
        .catch(() => {
          // error-policy:J4 an initial probe failure is not a permission state;
          // keep the card visible with an explicit retry affordance.
          if (!cancelled && ownsOperation(operation)) {
            setOperationError("check");
          }
        })
        .finally(() => {
          finishOperation(operation, "check");
        });
    }
    const unsubscribe = registry.subscribe((states) => {
      const next = states.find((s) => s.id === permission);
      if (next) {
        if (!cancelled) {
          setState(next);
          setOperationError(null);
        }
      }
    });
    return () => {
      cancelled = true;
      if (operation && operationInFlightRef.current === operation.token) {
        operationInFlightRef.current = null;
      }
      operationEpochRef.current += 1;
      unsubscribe();
    };
  }, [beginOperation, finishOperation, ownsOperation, permission, registry]);

  if (dismissed) return null;

  // Defensive: agent shouldn't emit a card for already-granted permissions.
  if (state.status === "granted") {
    return (
      <div
        data-testid="permission-card-granted"
        className={cn(
          "mt-2 inline-flex items-center gap-1.5 rounded-sm border border-success/30 bg-success/10 px-2 py-1 text-xs font-medium text-success",
          className,
        )}
      >
        {labels.granted ?? "Access granted"} ✓
      </div>
    );
  }

  const isRestrictedEntitlement =
    state.status === "restricted" &&
    state.restrictedReason === "entitlement_required";

  const isRestrictedUnavailable =
    state.status === "restricted" &&
    (state.restrictedReason === "platform_unsupported" ||
      state.restrictedReason === undefined);

  const canOpenSettingsInstead =
    state.status === "opaque" ||
    (state.canRequest === false &&
      (state.status === "denied" ||
        state.status === "not-determined" ||
        (state.status === "restricted" &&
          state.restrictedReason === "os_policy")));

  const title = getPermissionLabel(permission);
  const guidance = permissionGuidance(permission, state, appName);
  const resolvedFallbackLabel =
    fallbackLabel ??
    (permission === "reminders" ? "Use internal reminder" : "Use fallback");
  const operationPending = requesting || checking || openingSettings;

  return (
    <section
      data-testid="permission-card"
      data-permission={permission}
      data-feature={feature}
      data-status={state.status}
      aria-label={`Permission request: ${title}`}
      className={cn(
        "mt-2 rounded-sm border border-border/40 bg-bg-accent/60 p-3",
        className,
      )}
    >
      <header className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-txt-strong">{title}</h3>
        <span className="rounded-full border border-border/50 px-2 py-0.5 text-[10px] font-medium uppercase text-muted">
          {statusLabel(state)}
        </span>
      </header>
      <p className="mb-3 text-sm leading-snug text-txt">{reason}</p>
      <div className="mb-3 rounded-sm border border-border/40 bg-surface/60 p-2 text-xs leading-relaxed text-muted">
        <p className="font-medium text-txt">{guidance.primary}</p>
        <p className="mt-1">{guidance.secondary}</p>
      </div>
      {operationError ? (
        <p
          role="alert"
          data-testid="permission-card-error"
          className="mb-3 rounded-sm border border-danger/30 bg-danger/10 p-2 text-xs leading-relaxed text-danger"
        >
          {permissionOperationErrorMessage(operationError)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {operationError === "check" ? (
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleCheckAgain()}
            disabled={operationPending}
            data-testid="permission-card-primary"
          >
            {checking ? "Checking..." : "Retry check"}
          </Button>
        ) : isRestrictedEntitlement ? (
          <Button
            variant="default"
            size="sm"
            disabled
            data-testid="permission-card-primary"
            title="Coming soon — requires app entitlement."
          >
            {labels.comingSoon ?? "Coming soon — requires app entitlement"}
          </Button>
        ) : isRestrictedUnavailable || state.status === "not-applicable" ? (
          <Button
            variant="default"
            size="sm"
            disabled
            data-testid="permission-card-primary"
          >
            {labels.unavailable ?? "Unavailable on this platform"}
          </Button>
        ) : canOpenSettingsInstead ? (
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleOpenSettings()}
            disabled={operationPending}
            data-testid="permission-card-primary"
          >
            {openingSettings
              ? "Opening Settings…"
              : (labels.openSettings ??
                (state.status === "opaque"
                  ? "Manage access"
                  : "Open System Settings"))}
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleGrant()}
            disabled={operationPending || !registry}
            data-testid="permission-card-primary"
          >
            {requesting
              ? (labels.granting ?? "Requesting…")
              : (labels.grantAccess ?? "Grant access")}
          </Button>
        )}
        {registry && operationError !== "check" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCheckAgain()}
            disabled={operationPending}
            data-testid="permission-card-check-again"
          >
            {checking ? "Checking..." : "Check again"}
          </Button>
        ) : null}
        {fallbackOffered ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleFallback}
            data-testid="permission-card-fallback"
          >
            {resolvedFallbackLabel}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          data-testid="permission-card-dismiss"
          className="ml-auto h-auto px-0 text-xs text-muted hover:bg-transparent hover:text-txt-strong"
        >
          {labels.notNow ?? "Not now"}
        </Button>
      </div>
    </section>
  );
}

function settingsOpenFailed(result: unknown): boolean {
  return (
    result === false ||
    (typeof result === "object" &&
      result !== null &&
      "opened" in result &&
      result.opened === false)
  );
}

function statusLabel(state: PermissionState): string {
  if (state.status === "opaque") return "Choices set";
  if (state.status === "not-determined") return "Not asked";
  if (state.status === "not-applicable") return "Unavailable";
  return state.status.replace(/-/g, " ");
}

function permissionOperationErrorMessage(
  operation: "check" | "request" | "settings",
): string {
  if (operation === "request") {
    return "The permission request failed before the OS confirmed a result. Try Grant access again or choose Check again.";
  }
  if (operation === "settings") {
    return "System Settings could not be opened. Try again or open the app's permission settings manually.";
  }
  return "The current permission state could not be read. Choose Check again to retry.";
}

function platformSettingsLabel(
  platform: PermissionState["platform"],
  appName: string,
): string {
  if (platform === "darwin") return "System Settings > Privacy & Security";
  if (platform === "ios") return `Settings > ${appName}`;
  if (platform === "android")
    return `Settings > Apps > ${appName} > Permissions`;
  if (platform === "win32") return "Windows privacy settings";
  if (platform === "linux") return "system privacy settings";
  return "browser settings";
}

function permissionGuidance(
  permission: PermissionId,
  state: PermissionState,
  appName: string,
): { primary: string; secondary: string } {
  const title = getPermissionLabel(permission);
  const settings = platformSettingsLabel(state.platform, appName);

  if (state.status === "opaque") {
    if (permission === "health") {
      return {
        primary: "Your Health data choices are set.",
        secondary: `iOS keeps individual HealthKit read choices private. ${appName} can query only the data you allowed; use Manage access to review or change those choices.`,
      };
    }
    return {
      primary: `${title} choices are managed by the operating system.`,
      secondary: `The OS does not reveal each individual choice. Use Manage access to review them in ${settings}.`,
    };
  }

  if (state.status === "not-applicable") {
    return {
      primary: `${title} is not available on this platform.`,
      secondary:
        "The agent can continue only if there is a fallback that does not use this device capability.",
    };
  }

  if (
    state.status === "restricted" &&
    state.restrictedReason === "platform_unsupported"
  ) {
    return {
      primary: `${title} is not available on this platform.`,
      secondary:
        "The agent can continue only if there is a fallback that does not use this device capability.",
    };
  }

  if (
    state.status === "restricted" &&
    state.restrictedReason === "entitlement_required"
  ) {
    return {
      primary: `${title} requires an app entitlement that is not available in this build.`,
      secondary:
        "A build signed with the required entitlement is needed before this feature can work.",
    };
  }

  if (state.status === "restricted") {
    return {
      primary: `${title} is controlled by the current OS or administrator policy.`,
      secondary: `Review ${settings}. A device profile or administrator policy may still prevent changes.`,
    };
  }

  if (state.status === "denied" || state.canRequest === false) {
    return {
      primary: `Turn on ${title} in ${settings}.`,
      secondary:
        "After enabling it, return here and choose Check again. If you changed your mind, you can leave it off and use any offered fallback.",
    };
  }

  if (permission === "usage-access") {
    return {
      primary: `Open Android Usage Access and allow ${appName}.`,
      secondary:
        "This lets app blocking and Screen Time features read foreground app usage. Return here and choose Check again when done.",
    };
  }

  if (permission === "overlay") {
    return {
      primary: `Allow ${appName} to draw over other apps in Android settings.`,
      secondary:
        "The blocking screen needs this to appear above distracting apps. If you cancel, press Grant access again.",
    };
  }

  if (permission === "write-settings") {
    return {
      primary: `Open Android Write Settings and allow ${appName}.`,
      secondary:
        "Android requires this separate settings screen for brightness and device-setting changes.",
    };
  }

  return {
    primary: `When the OS prompt appears, choose Allow for ${title}.`,
    secondary: `If you cancel by accident, press Grant access again. If the OS stops prompting, open settings, enable it for ${appName}, then check again.`,
  };
}
