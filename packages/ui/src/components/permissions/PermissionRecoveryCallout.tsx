/**
 * Alert callout shown when a permission is denied — offers Retry (`onRetry`) and
 * an "Open Settings" affordance that deep-links to the OS permission screen.
 * Routes to the native mobile deep-link on Capacitor (non-Electrobun) and the
 * shared web/desktop deep-link elsewhere. Consumed by the permission-priming
 * modal and permission settings rows.
 */
import { Capacitor } from "@capacitor/core";
import { ElizaError } from "@elizaos/core";
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import { openPermissionSettings } from "@elizaos/shared/utils/permission-deep-links";
import { useRef, useState } from "react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { cn } from "../../lib/utils";
import { openMobilePermissionSettings } from "../../platform/mobile-permissions-client";
import { Button } from "../ui/button";

export interface PermissionRecoveryCalloutProps {
  permission: PermissionId;
  title: string;
  description: string;
  retryLabel?: string;
  settingsLabel?: string;
  onOpenSettings?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  className?: string;
  testId?: string;
}

function isNativeMobileRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform() && !isElectrobunRuntime();
  } catch {
    // error-policy:J4 capability probe — no Capacitor runtime means the
    // web-flavored recovery copy is shown.
    return false;
  }
}

export function PermissionRecoveryCallout({
  permission,
  title,
  description,
  retryLabel = "Try again",
  settingsLabel = "Open Settings",
  onOpenSettings,
  onRetry,
  className,
  testId = "permission-recovery-callout",
}: PermissionRecoveryCalloutProps): React.JSX.Element {
  const [opening, setOpening] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [operationError, setOperationError] = useState<
    "settings" | "retry" | null
  >(null);
  const operationInFlightRef = useRef(false);

  const handleOpenSettings = async () => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setOperationError(null);
    setOpening(true);
    try {
      if (onOpenSettings) {
        await onOpenSettings();
      } else if (isNativeMobileRuntime()) {
        const result = await openMobilePermissionSettings(permission);
        if (result?.opened !== true) {
          throw new ElizaError(
            result?.reason ??
              `Could not open settings for the "${permission}" permission`,
            {
              code: "PERMISSION_RECOVERY_SETTINGS_OPEN_FAILED",
              context: { permission },
              severity: "ephemeral",
            },
          );
        }
      } else {
        await openPermissionSettings(permission);
      }
    } catch {
      // error-policy:J4 settings failures remain visible and retryable instead
      // of looking like a successful navigation.
      setOperationError("settings");
    } finally {
      operationInFlightRef.current = false;
      setOpening(false);
    }
  };

  const handleRetry = async () => {
    if (!onRetry || operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setOperationError(null);
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // error-policy:J4 a failed probe/request is not a permission result.
      setOperationError("retry");
    } finally {
      operationInFlightRef.current = false;
      setRetrying(false);
    }
  };

  const busy = opening || retrying;

  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        "rounded-sm border border-warn/30 bg-warn/10 p-3 text-left",
        className,
      )}
    >
      <div className="text-sm font-semibold text-txt-strong">{title}</div>
      <p className="mt-1 text-sm leading-snug text-txt">{description}</p>
      {operationError ? (
        <p
          role="alert"
          data-testid={`${testId}-error`}
          className="mt-2 text-xs text-danger"
        >
          {operationError === "settings"
            ? "Settings could not be opened. Try again."
            : "The permission check did not complete. Try again."}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => void handleOpenSettings()}
          disabled={busy}
          data-testid={`${testId}-settings`}
        >
          {opening ? "Opening..." : settingsLabel}
        </Button>
        {onRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleRetry()}
            disabled={busy}
            data-testid={`${testId}-retry`}
          >
            {retrying ? "Checking..." : retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
