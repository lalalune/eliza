/**
 * Coordinates the onboarding soft-ask permission sequence across web, desktop,
 * and native registries without prompting the OS until the user opts in.
 */
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionStatus,
} from "@elizaos/shared/contracts/permissions";
import * as React from "react";
import { client } from "../../api/client";
import { isDesktopPlatform, isNative } from "../../platform";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "../../platform/mobile-permissions-client";
import { createClientPermissionsRegistry } from "../composites/chat/permission-card.helpers";

/**
 * Sequencing controller for the onboarding permission-priming modal.
 *
 * Generalizes the single-permission `useMicrophonePermission` to an ordered set
 * of PermissionIds and walks them one card at a time. It reuses the exact same
 * platform routing every other permission surface uses — the native
 * MobileSignals registry on iOS/Android, the (desktop-patched or web) client
 * registry elsewhere — so there is no second permission client.
 *
 * Soft-ask: the OS dialog is only fired from `request()` (the card's "Enable"
 * tap). Nothing here prompts on mount — mount only *checks* current status so
 * already-granted permissions are skipped and never re-prompted.
 *
 * Operations do not throw through click handlers. Transport/native failures
 * are kept separate from permission status and rendered on the affected card.
 */

export type PrimingItemStatus = PermissionStatus | null;
export type PrimingItemOperation = "check" | "request" | "settings" | "recheck";

export interface PrimingItemError {
  operation: PrimingItemOperation;
}

export interface PrimingItem {
  id: PermissionId;
  /** Null only when the OS state could not be read. */
  status: PrimingItemStatus;
  /** Whether the OS request can still be (re)fired; false once hard-denied. */
  canRequest: boolean;
  /** True while this item's request, settings navigation, or probe is in flight. */
  requesting: boolean;
  /** A transport/native failure, never a synthesized permission result. */
  error?: PrimingItemError;
  /**
   * True once the user is done with this card — granted, or explicitly skipped.
   * A denied item is NOT resolved: it stays active so the recovery affordance
   * shows and the user can retry, open settings, or skip.
   */
  resolved: boolean;
}

export interface PermissionPrimingController {
  /** Unresolved items in order (terminal permission states are excluded). */
  items: PrimingItem[];
  /** Index into `items` of the first unresolved card, or `items.length`. */
  activeIndex: number;
  /** The card currently shown, or null when the sequence is complete. */
  active: PrimingItem | null;
  /** 1-based position of the active card for a "x of N" indicator. */
  currentStep: number;
  /** Total number of cards in the sequence. */
  totalSteps: number;
  /** True once the initial status check has completed. */
  ready: boolean;
  /** True when every item is resolved (or there were none). */
  done: boolean;
  /** Fire the OS request for `id` (the "Enable" tap). */
  request: (id: PermissionId) => Promise<void>;
  /** Skip `id` without touching the OS (soft-deny; capability preserved). */
  skip: (id: PermissionId) => void;
  /** Open OS settings so a hard-denied permission can be granted manually. */
  openSettings: (id: PermissionId) => Promise<void>;
  /** Re-check `id`'s status (e.g. after returning from OS settings). */
  recheck: (id: PermissionId) => Promise<void>;
  /** Skip every remaining card at once ("Not now" for the whole flow). */
  skipAll: () => void;
}

const PRIMING_FEATURE = { app: "onboarding", action: "permission-priming" };
const PRIMING_REASON =
  "Requested during onboarding so the assistant is ready to use this feature.";

/** Statuses that need no action, so their card is never shown. */
function isSatisfied(status: PrimingItemStatus): boolean {
  return (
    status === "granted" ||
    status === "not-applicable" ||
    status === "restricted" ||
    status === "opaque"
  );
}

function selectRegistry(): IPermissionsRegistry {
  return isNative && !isDesktopPlatform()
    ? createMobileSignalsPermissionsRegistry(undefined, client)
    : createClientPermissionsRegistry(client);
}

async function openSettingsFor(id: PermissionId): Promise<boolean> {
  if (isNative && !isDesktopPlatform()) {
    const result = await openMobilePermissionSettings(id);
    return result?.opened === true;
  }
  await client.openPermissionSettings(id);
  return true;
}

export function usePermissionPriming(
  ids: readonly PermissionId[],
): PermissionPrimingController {
  const registry = React.useMemo(selectRegistry, []);
  const idsKey = ids.join(",");

  const [items, setItems] = React.useState<PrimingItem[]>([]);
  const [ready, setReady] = React.useState(false);
  const generationRef = React.useRef(0);
  const inFlightRef = React.useRef<Map<PermissionId, symbol>>(new Map());
  const ownsOperation = React.useCallback(
    (id: PermissionId, token: symbol, generation: number) =>
      generation === generationRef.current &&
      inFlightRef.current.get(id) === token,
    [],
  );

  // Mount check: probe each id WITHOUT prompting, then keep only the ones that
  // still need action. Terminal states, including privacy-opaque decisions,
  // are dropped so no card can re-prompt them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idsKey` is the stable string identity of `ids`; depending on the `ids` array itself would re-run the OS status check on every render for callers that pass a fresh array literal.
  React.useEffect(() => {
    let cancelled = false;
    const generation = ++generationRef.current;
    inFlightRef.current = new Map();
    setReady(false);
    setItems([]);
    void (async () => {
      const checked = await Promise.all(
        ids.map(async (id) => {
          try {
            const state = await registry.check(id);
            return {
              id,
              status: state.status,
              canRequest: state.canRequest,
              error: undefined,
            };
          } catch {
            // error-policy:J4 initial probe failures become explicit card
            // errors; null is not a permission status and cannot prompt.
            return {
              id,
              status: null,
              canRequest: false,
              error: { operation: "check" as const },
            };
          }
        }),
      );
      if (cancelled || generation !== generationRef.current) return;
      setItems(
        checked
          .filter((entry) => !isSatisfied(entry.status))
          .map((entry) => ({
            id: entry.id,
            status: entry.status,
            canRequest: entry.canRequest,
            requesting: false,
            resolved: false,
            ...(entry.error ? { error: entry.error } : {}),
          })),
      );
      setReady(true);
    })();
    return () => {
      cancelled = true;
      if (generation === generationRef.current) generationRef.current += 1;
    };
    // idsKey captures the id list identity; registry is stable (useMemo []).
  }, [idsKey, registry]);

  const patch = React.useCallback(
    (id: PermissionId, next: Partial<PrimingItem>) => {
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, ...next } : item)),
      );
    },
    [],
  );

  const request = React.useCallback(
    async (id: PermissionId) => {
      if (inFlightRef.current.has(id)) return;
      const token = Symbol(id);
      const generation = generationRef.current;
      inFlightRef.current.set(id, token);
      patch(id, { requesting: true });
      try {
        const state = await registry.request(id, {
          reason: PRIMING_REASON,
          feature: PRIMING_FEATURE,
        });
        if (!ownsOperation(id, token, generation)) return;
        patch(id, {
          status: state.status,
          canRequest: state.canRequest,
          requesting: false,
          error: undefined,
          // Terminal states resolve the card; a denial remains active for recovery.
          resolved: isSatisfied(state.status),
        });
      } catch {
        // error-policy:J4 request failure is not an OS denial; preserve the
        // last known status and expose a retry on the active card.
        if (!ownsOperation(id, token, generation)) return;
        patch(id, {
          requesting: false,
          error: { operation: "request" },
        });
      } finally {
        if (inFlightRef.current.get(id) === token) {
          inFlightRef.current.delete(id);
        }
      }
    },
    [ownsOperation, patch, registry],
  );

  const skip = React.useCallback(
    (id: PermissionId) => {
      inFlightRef.current.delete(id);
      patch(id, { resolved: true });
    },
    [patch],
  );

  const openSettings = React.useCallback(
    async (id: PermissionId) => {
      if (inFlightRef.current.has(id)) return;
      const token = Symbol(id);
      const generation = generationRef.current;
      inFlightRef.current.set(id, token);
      patch(id, { requesting: true });
      try {
        const opened = await openSettingsFor(id);
        if (!ownsOperation(id, token, generation)) return;
        if (!opened) {
          patch(id, {
            requesting: false,
            error: { operation: "settings" },
          });
          return;
        }
        patch(id, { requesting: false, error: undefined });
      } catch {
        // error-policy:J4 settings navigation failure is visible and retries
        // the same operation; it is not translated into denial.
        if (!ownsOperation(id, token, generation)) return;
        patch(id, {
          requesting: false,
          error: { operation: "settings" },
        });
      } finally {
        if (inFlightRef.current.get(id) === token) {
          inFlightRef.current.delete(id);
        }
      }
    },
    [ownsOperation, patch],
  );

  const recheck = React.useCallback(
    async (id: PermissionId) => {
      if (inFlightRef.current.has(id)) return;
      const token = Symbol(id);
      const generation = generationRef.current;
      inFlightRef.current.set(id, token);
      patch(id, { requesting: true });
      try {
        const state = await registry.check(id);
        if (!ownsOperation(id, token, generation)) return;
        patch(id, {
          status: state.status,
          canRequest: state.canRequest,
          requesting: false,
          error: undefined,
          resolved: isSatisfied(state.status),
        });
      } catch {
        // error-policy:J4 a failed recheck is rendered separately while the
        // last known permission state remains intact.
        if (!ownsOperation(id, token, generation)) return;
        patch(id, {
          requesting: false,
          error: { operation: "recheck" },
        });
      } finally {
        if (inFlightRef.current.get(id) === token) {
          inFlightRef.current.delete(id);
        }
      }
    },
    [ownsOperation, patch, registry],
  );

  const skipAll = React.useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current = new Map();
    setItems((current) => current.map((item) => ({ ...item, resolved: true })));
  }, []);

  const activeIndex = items.findIndex((item) => !item.resolved);
  const active = activeIndex === -1 ? null : items[activeIndex];
  const done = ready && active === null;

  return {
    items,
    activeIndex: activeIndex === -1 ? items.length : activeIndex,
    active,
    currentStep: activeIndex === -1 ? items.length : activeIndex + 1,
    totalSteps: items.length,
    ready,
    done,
    request,
    skip,
    openSettings,
    recheck,
    skipAll,
  };
}
