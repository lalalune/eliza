/**
 * useAgentSessionRecovery, bridges the unauthenticated auth state (#15132) to
 * a transparent re-pair instead of the password-wall dead-end.
 *
 * When `/api/auth/me` 401s AFTER a dedicated cloud agent's container upgrade,
 * the browser's persisted agent credential is stale but the cloud session is
 * still valid. This hook detects that exact case and re-runs the cloud pairing
 * exchange in the current window (the same flow first-pairing uses), which pins
 * a fresh credential and reloads onto `/` re-paired. In every other case (no
 * cloud session / self-hosted / already-attempted) it stays "idle" so the
 * top-level auth gate renders `LoginView` exactly as before.
 *
 * SECURITY (auth-adjacent): this NEVER bypasses the wall. Recovery only fires
 * when a valid cloud session exists to re-pair from; the server still gates the
 * pairing-token mint. Managed-Cloud failures hand control to Cloud sign-in;
 * only self-hosted agents can fall through to the local owner-password form.
 */

import { useEffect, useRef, useState } from "react";
import { getCloudAuthToken } from "../api/client-cloud";
import { getBootConfig } from "../config/boot-config";
import {
  type AgentSessionUnauthReason,
  agentSessionRepairNeedsCloudToken,
  resolveAgentSessionRecovery,
} from "../state/agent-session-recovery";
import { runAgentSessionRecovery } from "../state/agent-session-recovery-runner";
import { clearStalePairCredentialsForAgent } from "../state/cloud-pair-token";
import { ensureCloudSessionForRepair } from "../state/cloud-session-refresh-for-repair";
import { loadPersistedActiveServer } from "../state/persistence";

export type AgentSessionRecoveryStatus =
  /** No managed-Cloud recovery is active; self-hosted agents render login. */
  | "idle"
  /** A re-pair is in flight, the auth gate should hold (no wall yet). */
  | "recovering"
  /** Managed Cloud needs a fresh Cloud session; never render local password. */
  | "cloud-sign-in-required";

interface UseAgentSessionRecoveryOptions {
  /**
   * Whether the app is currently in the unauthenticated state, and (when so)
   * the `/api/auth/me` reason. `active: false` disables the hook entirely.
   */
  active: boolean;
  reason: AgentSessionUnauthReason;
  /** Injected navigate (tests). Defaults to a full-page window assignment. */
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  if (typeof window !== "undefined") {
    window.location.assign(url);
  }
}

function shouldConsumePairRedirectInProcess(): boolean {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export function useAgentSessionRecovery(
  options: UseAgentSessionRecoveryOptions,
): AgentSessionRecoveryStatus {
  const { active, reason, navigate = defaultNavigate } = options;
  const [status, setStatus] = useState<AgentSessionRecoveryStatus>("idle");
  // One attempt per mount cycle prevents a stale credential from creating an
  // infinite re-pair loop; a failed managed-Cloud attempt requires sign-in.
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      // Reset when the app leaves the unauthenticated state (e.g. a successful
      // re-pair reloaded auth), so a later genuine 401 can recover again.
      attemptedRef.current = false;
      setStatus("idle");
      return;
    }

    if (attemptedRef.current) {
      const exhaustedDecision = resolveAgentSessionRecovery({
        reason,
        activeServer: loadPersistedActiveServer(),
        cloudToken: getCloudAuthToken(),
        cloudApiBase:
          getBootConfig().cloudApiBase?.trim() || "https://elizacloud.ai",
        alreadyAttempted: true,
      });
      setStatus(
        exhaustedDecision.action === "show-cloud-sign-in"
          ? "cloud-sign-in-required"
          : "idle",
      );
      return;
    }

    let cancelled = false;

    const resolveInput = (
      cloudToken: string | null,
      // The outer attempt guard lives on `attemptedRef`; this flag is for the
      // resolver's own loop-guard. When re-resolving AFTER a successful cookie
      // refresh we pass `false` so the freshly-recovered token can re-pair (the
      // refresh IS this cycle's one attempt, gated by the caller).
      alreadyAttempted: boolean = attemptedRef.current,
    ) => ({
      reason,
      activeServer: loadPersistedActiveServer(),
      cloudToken,
      cloudApiBase:
        getBootConfig().cloudApiBase?.trim() || "https://elizacloud.ai",
      alreadyAttempted,
    });

    const startRepair = (
      decision: ReturnType<typeof resolveAgentSessionRecovery>,
      cloudToken: string,
    ) => {
      if (decision.action !== "re-pair") {
        setStatus(
          decision.action === "show-cloud-sign-in"
            ? "cloud-sign-in-required"
            : "idle",
        );
        return;
      }
      setStatus("recovering");
      void runAgentSessionRecovery({
        cloudApiBase: decision.cloudApiBase,
        agentId: decision.agentId,
        cloudToken,
        consumeRedirectInProcess: shouldConsumePairRedirectInProcess(),
        clearStalePairCredentials: () =>
          clearStalePairCredentialsForAgent(decision.agentId),
        onPairedInProcess: async (apiToken) => {
          const { client } = await import("../api");
          client.setToken(apiToken);
        },
        navigate,
      })
        .then((result) => {
          if (cancelled) return;
          // Browser success navigates; native success adopts the token
          // in-process. A managed Cloud failure always returns to Cloud sign-in.
          if (!result.ok) setStatus("cloud-sign-in-required");
        })
        .catch(() => {
          if (!cancelled) setStatus("cloud-sign-in-required");
        });
    };

    const initialInput = resolveInput(getCloudAuthToken());
    const initialDecision = resolveAgentSessionRecovery(initialInput);

    if (initialDecision.action === "re-pair") {
      // Fast path: app-origin cloud token already present, re-pair immediately
      // (the classic post-upgrade stale-credential case).
      attemptedRef.current = true;
      startRepair(initialDecision, getCloudAuthToken() as string);
      return () => {
        cancelled = true;
      };
    }

    if (!agentSessionRepairNeedsCloudToken(initialInput)) {
      // Self-hosted targets use their password wall. Managed Cloud targets whose
      // state cannot be silently repaired return to Cloud sign-in.
      setStatus(
        initialDecision.action === "show-cloud-sign-in"
          ? "cloud-sign-in-required"
          : "idle",
      );
      return;
    }

    // Re-pair-shaped in every dimension EXCEPT the app-origin cloud token: this
    // is the returning-PWA "Open this agent from Eliza Cloud" dead-end. The user
    // IS signed in to Eliza Cloud (shared HttpOnly `.elizacloud.ai` cookie), but
    // this origin's token mirror is empty. Recover the session from the cookie
    // silently and re-pair, instead of dropping to the terminal notice.
    attemptedRef.current = true;
    setStatus("recovering");

    void ensureCloudSessionForRepair()
      .then((token) => {
        if (cancelled) return;
        if (!token) {
          setStatus("cloud-sign-in-required");
          return;
        }
        const decision = resolveAgentSessionRecovery(
          resolveInput(token, false),
        );
        startRepair(decision, token);
      })
      .catch(() => {
        if (!cancelled) setStatus("cloud-sign-in-required");
      });

    return () => {
      cancelled = true;
    };
    // `active`/`reason`/`navigate` are the only third-party inputs; setStatus and
    // attemptedRef are stable, so the dependency list is exhaustive as written.
  }, [active, reason, navigate]);

  return status;
}
