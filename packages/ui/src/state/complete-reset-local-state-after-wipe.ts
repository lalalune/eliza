/**
 * Wipes **renderer-local** state after the server already ran `POST /api/agent/reset`.
 *
 * **WHY:** post-wipe, persisted active server + API base + Eliza Cloud flags
 * could still point at cloud/remote, so firstRun never appeared "fresh."
 *
 * **WHY dependency injection:** `useChatLifecycle` is the sole production
 * caller and wires real `client` and React setters; the explicit deps record
 * keeps the orchestrator pure and lets unit tests assert call order without
 * jsdom (see `complete-reset-local-state-after-wipe.test.ts`).
 *
 * **Atomicity contract:**
 *  - Connection teardown and renderer credential deletion run before any UI
 *    callback that could throw. A server-side wipe must never leave credentials
 *    behind merely because a React/state callback failed afterward.
 *  - Renderer-storage cleanup is awaited and may fail the reset if a credential
 *    survives. The remaining synchronous callbacks then fire in fixed order,
 *    so React batches them into a single render commit.
 *  - `fetchFirstRunOptions` is the only failure that may degrade. Its
 *    try/catch is in-function: a failed fetch leaves first-run options
 *    stale but does NOT roll back the rest of the wipe (rolling back would
 *    be worse than stale options — the user could still re-fetch on next
 *    boot, but a half-wiped session leaks cloud/remote credentials).
 *  - All other callbacks are uncaught by design. If any throws, the entire
 *    cascade aborts and the failure surfaces to the calling lifecycle (the
 *    `handleResetAppliedFromMain` / `handleReset` callers in
 *    `useChatLifecycle.ts` show the desktop alert + log the warning). We do
 *    NOT swallow failures or default-fill state — that would mask a broken
 *    pipeline with apparent success.
 *  - The cascade is the sole caller of each deps-record callback. No code
 *    path calls one without the others, and credential cleanup stays behind
 *    one awaited barrier.
 */
import type { AgentStatus, FirstRunOptions } from "../api/client";

/**
 * Ports for `completeResetLocalStateAfterServerWipe` (all side effects explicit).
 */
export type CompleteResetLocalStateDeps = {
  setAgentStatus: (status: AgentStatus | null) => void;
  resetClientConnection: () => void;
  clearPersistedActiveServer: () => void;
  clearPersistedAvatarIndex: () => void;
  setClientBaseUrl: (url: string | null) => void;
  setClientToken: (token: string | null) => void;
  clearElizaCloudSessionUi: () => void;
  markFirstRunReset: () => void;
  resetAvatarSelection: () => void;
  clearConversationLists: () => void;
  clearRendererStorage: () => Promise<void>;
  fetchFirstRunOptions: () => Promise<FirstRunOptions>;
  setFirstRunOptions: (options: FirstRunOptions) => void;
  logResetDebug: (message: string, detail?: Record<string, unknown>) => void;
  logResetWarn: (message: string, detail?: unknown) => void;
};

export async function completeResetLocalStateAfterServerWipe(
  postResetAgentStatus: AgentStatus | null,
  d: CompleteResetLocalStateDeps,
): Promise<void> {
  const teardownErrors: unknown[] = [];
  try {
    d.logResetDebug("resetLocalState: client.resetConnection()");
  } catch (error) {
    // error-policy:J1 reset still attempts the credential barrier when
    // diagnostics or connection teardown fail at this outer boundary.
    teardownErrors.push(error);
  }
  try {
    d.resetClientConnection();
  } catch (error) {
    // error-policy:J1 renderer credential cleanup is an independent mandatory
    // postcondition after the server has already completed its destructive wipe.
    teardownErrors.push(error);
  }
  try {
    d.logResetDebug("resetLocalState: clearing renderer storage");
  } catch (error) {
    // error-policy:J1 diagnostics cannot prevent destructive credential cleanup.
    teardownErrors.push(error);
  }
  try {
    await d.clearRendererStorage();
  } catch (error) {
    // error-policy:J1 preserve cleanup failure alongside any connection failure.
    teardownErrors.push(error);
  }
  if (teardownErrors.length === 1) throw teardownErrors[0];
  if (teardownErrors.length > 1) {
    throw new AggregateError(teardownErrors, "Renderer reset teardown failed");
  }

  d.setAgentStatus(postResetAgentStatus);
  d.clearPersistedActiveServer();
  d.clearPersistedAvatarIndex();
  d.setClientBaseUrl(null);
  d.setClientToken(null);
  d.clearElizaCloudSessionUi();
  d.markFirstRunReset();
  d.resetAvatarSelection();
  d.clearConversationLists();
  try {
    d.logResetDebug("resetLocalState: fetching first-run options after reset");
    const options = await d.fetchFirstRunOptions();
    d.setFirstRunOptions(options);
    d.logResetDebug("resetLocalState: first-run options loaded", {
      styleCount: options.styles?.length ?? 0,
    });
  } catch (optErr) {
    d.logResetWarn(
      "resetLocalState: getFirstRunOptions failed after reset",
      optErr,
    );
  }
}
