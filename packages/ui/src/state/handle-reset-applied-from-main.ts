/**
 * Renderer path after the **main process** finishes menu reset and pushes
 * `desktopTrayMenuClick` with `itemId: "menu-reset-app-applied"`.
 *
 * **WHY a separate module:** `AppProvider` is enormous; this flow needs lifecycle
 * guards, `setActionNotice`, and `finishLifecycleAction` in **unit tests** without
 * mounting React. **WHY reuse `completeResetLocalState`:** Settings `handleReset`
 * and main-process reset must apply the **same** client + first-run + cloud
 * teardown or the two entry points drift.
 */
import type { AgentStatus } from "../api/client";
import { LIFECYCLE_MESSAGES, type LifecycleAction } from "./types";

export type HandleResetAppliedFromMainDeps = {
  performanceNow: () => number;
  isLifecycleBusy: () => boolean;
  getActiveLifecycleAction: () => LifecycleAction;
  beginLifecycleAction: (action: LifecycleAction) => boolean;
  finishLifecycleAction: () => void;
  setActionNotice: (
    text: string,
    tone: "info" | "success" | "error",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;
  parseTrayResetPayload: (payload: unknown) => AgentStatus | null;
  completeResetLocalState: (
    postResetAgentStatus: AgentStatus | null,
  ) => Promise<void>;
  alertDesktopMessage: (args: {
    title: string;
    message: string;
    type: "error";
  }) => Promise<void>;
  logResetInfo: (message: string, detail?: Record<string, unknown>) => void;
  logResetWarn: (message: string, detail?: unknown) => void;
};

export async function handleResetAppliedFromMainCore(
  payload: unknown,
  d: HandleResetAppliedFromMainDeps,
): Promise<void> {
  d.logResetInfo(
    "handleResetAppliedFromMain: main process finished reset — syncing renderer state",
  );
  let ownsResetLifecycle = false;
  if (d.isLifecycleBusy()) {
    const activeAction = d.getActiveLifecycleAction();
    d.logResetInfo(
      "handleResetAppliedFromMain: superseding lifecycle after shell reset",
      {
        activeAction,
      },
    );
    d.setActionNotice(
      `Reset finished in the desktop shell; cancelling ${LIFECYCLE_MESSAGES[activeAction].inProgress} and clearing local state.`,
      "info",
      4200,
    );
    // The destructive operation has already happened in main. The renderer's
    // previous lifecycle can no longer complete against its old state, so its
    // logical lock must not prevent mandatory credential/local cleanup.
    d.finishLifecycleAction();
  }
  ownsResetLifecycle = d.beginLifecycleAction("reset");
  if (!ownsResetLifecycle) {
    d.logResetWarn(
      "handleResetAppliedFromMain: reset lifecycle lock unavailable; applying mandatory renderer cleanup without it",
      {
        activeAction: d.getActiveLifecycleAction(),
      },
    );
  }
  d.setActionNotice(
    LIFECYCLE_MESSAGES.reset.progress,
    "info",
    120_000,
    false,
    true,
  );
  const resetStartedAt = d.performanceNow();
  try {
    const parsedStatus = d.parseTrayResetPayload(payload);
    await d.completeResetLocalState(parsedStatus);
    const elapsedMs = Math.round(d.performanceNow() - resetStartedAt);
    d.logResetInfo(
      "handleResetAppliedFromMain: success — local UI synced after shell reset",
      { elapsedMs },
    );
    d.setActionNotice(LIFECYCLE_MESSAGES.reset.success, "success", 3200);
  } catch (err) {
    const elapsedMs = Math.round(d.performanceNow() - resetStartedAt);
    d.logResetWarn(
      "handleResetAppliedFromMain: failed while syncing local UI",
      { err, elapsedMs },
    );
    d.setActionNotice(
      `Failed to ${LIFECYCLE_MESSAGES.reset.verb} agent: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      "error",
      4200,
    );
    await d.alertDesktopMessage({
      title: "Reset Failed",
      message: "Reset ran in the desktop shell but the UI could not refresh.",
      type: "error",
    });
  } finally {
    if (ownsResetLifecycle) {
      d.finishLifecycleAction();
    }
  }
}
