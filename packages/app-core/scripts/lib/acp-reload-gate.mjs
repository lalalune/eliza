/**
 * Hot-reload safety gate for the dev host: decides whether a backend source
 * change may bounce the API child while coding sub-agent (ACP) sessions run.
 * dev-ui.mjs consumes it on both the watcher path and the one-shot
 * `--check-acp-hot-reload` probe. The mid-flight status set mirrors
 * `ACP_MIDFLIGHT_SESSION_STATUSES` in acp-service.ts — a reload SIGTERMs the
 * runtime that owns every live session, so any of these states must defer it.
 * A deferred reload is remembered and re-checked on an interval so the dev
 * runtime picks up the edit once sessions drain, instead of staying stale
 * until the next unrelated file change.
 */

export const ACP_MIDFLIGHT_SESSION_STATUSES = new Set([
  "running",
  "busy",
  "tool_running",
]);

/**
 * True when any coding-agent session is mid-flight. The response must be
 * trustworthy before a reload is authorized: an unreadable session list throws
 * (uncertainty defers the destructive action) instead of reading as
 * healthy-empty. A 404 means the orchestrator plugin is absent, which cannot
 * own a session — that is the only shape allowed to report "no sessions".
 */
export async function hasBusyAcpSessions(port, { fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(`http://127.0.0.1:${port}/api/coding-agents`, {
    signal: AbortSignal.timeout(1500),
  });
  if (resp.status === 404) {
    // error-policy:J4 the orchestrator is explicitly unavailable, so it cannot
    // own an ACP session that the host must preserve across a reload.
    return false;
  }
  if (!resp.ok) {
    throw new Error(`coding-agent session check returned HTTP ${resp.status}`);
  }

  const body = await resp.json();
  const sessions = Array.isArray(body) ? body : body?.sessions;
  if (!Array.isArray(sessions)) {
    throw new Error("coding-agent session check returned an invalid payload");
  }
  return sessions.some((session) =>
    ACP_MIDFLIGHT_SESSION_STATUSES.has(session?.status),
  );
}

/**
 * Stateful reload gate for the source watcher. `handleSourceChange` either
 * reloads immediately or defers; a deferred change starts an interval that
 * re-checks the session set and fires the reload once every session has
 * drained. Only the LATEST deferred path is kept — one restart picks up every
 * edit made in the meantime, so queueing more would only restart repeatedly.
 *
 * Collaborators are injected (readiness probe, busy probe, restart, logging)
 * so the policy is unit-testable without a dev stack; dev-ui.mjs wires the
 * real ones.
 */
export function createAcpReloadGate({
  isAgentReady,
  hasBusySessions,
  requestReload,
  log,
  warn,
  pollMs = 15_000,
}) {
  /** @type {string | null} relPath of the most recent deferred source change */
  let pendingPath = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let drainTimer = null;
  let stopped = false;

  function clearPending() {
    pendingPath = null;
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
  }

  function defer(relPath, reason, { uncertain = false } = {}) {
    pendingPath = relPath;
    const message = `Source change (${relPath}) — deferred: ${reason}; retrying every ${Math.round(pollMs / 1000)}s until sessions drain`;
    if (uncertain) warn(message);
    else log(message);
    if (!drainTimer) {
      drainTimer = setInterval(() => {
        void drainTick();
      }, pollMs);
      drainTimer.unref?.();
    }
  }

  async function drainTick() {
    if (stopped || !pendingPath) {
      clearPending();
      return;
    }
    if (!(await isAgentReady())) {
      // The agent went down or is rebooting for another reason; a boot always
      // loads the newest source, so the deferred reload is already satisfied.
      log(
        `Deferred source change (${pendingPath}) — dropped: agent is restarting and boots the latest source`,
      );
      clearPending();
      return;
    }
    try {
      if (await hasBusySessions()) return;
    } catch {
      // error-policy:J4 an uncertain session snapshot keeps the reload
      // deferred; the next interval tick re-checks it.
      return;
    }
    const relPath = pendingPath;
    clearPending();
    log(
      `Deferred source change (${relPath}) — sessions drained, reloading agent…`,
    );
    requestReload(relPath);
  }

  return {
    async handleSourceChange(relPath) {
      if (stopped) return;
      if (!(await isAgentReady())) return;
      try {
        if (await hasBusySessions()) {
          defer(
            relPath,
            "a coding sub-agent session is busy (reload would kill it)",
          );
          return;
        }
      } catch (error) {
        // error-policy:J4 an uncertain session snapshot visibly defers the
        // reload because restarting could destroy an unobserved live turn.
        defer(
          relPath,
          `ACP session safety check failed (${error instanceof Error ? error.message : String(error)})`,
          { uncertain: true },
        );
        return;
      }
      clearPending();
      log(`Source change (${relPath}) — reloading agent…`);
      requestReload(relPath);
    },
    /** Tear the drain interval down on dev-host shutdown. */
    stop() {
      stopped = true;
      clearPending();
    },
  };
}
