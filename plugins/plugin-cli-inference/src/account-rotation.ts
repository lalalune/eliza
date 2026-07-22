/**
 * Runtime-scoped subscription-account selection for isolated CLI SDK calls.
 * The core bridge supplies first-party Claude/Codex auth without an app-core
 * dependency; this module pins and refreshes the serving account, serializes
 * rotation, and retries rate-limit failures before provider failover (#11180).
 * Ambient and pooled children receive only process-launch essentials plus the
 * selected backend's canonical auth variables.
 */

import { randomUUID } from "node:crypto";
import {
  type CodingAccountStrategy,
  type CodingAgentSelectorBridge,
  getCodingAgentSelectorBridge,
  logger,
} from "@elizaos/core";
import { filterEnv } from "./sandbox";

export type RotationAgentType = "claude" | "codex";
export type RotationSubprocessEnv = Record<string, string | undefined>;

interface RotationState {
  bridge: CodingAgentSelectorBridge;
  selection: Omit<RotationAccountSelection, "envPatch">;
}

let scopedRotationState = new WeakMap<object, Map<string, RotationState>>();
let scopedRotationChains = new WeakMap<object, Map<string, Promise<void>>>();
const MAX_ROTATION_STATE_ENTRIES = 10_000;

/** A selected account plus the env the first-party subprocess needs to auth as it. */
export interface RotationAccountSelection {
  providerId: string;
  accountId: string;
  label: string;
  source: "oauth" | "api-key";
  strategy: string;
  /** Secrets / paths injected into the SDK subprocess env, never persisted or logged. */
  envPatch: Record<string, string>;
}

/**
 * Read the installed bridge, or null when no pool has been constructed. The
 * bridge symbol + contract are single-sourced in `@elizaos/core`.
 */
export function getCodingAccountBridge(): CodingAgentSelectorBridge | null {
  return getCodingAgentSelectorBridge();
}

/**
 * The SDK backends whose credential-bound state authenticates per pooled account. The
 * cold `claude --print` / `codex exec` CLIs read the machine's single on-disk
 * login and are out of scope for in-runtime rotation (they'd need the CLI shim,
 * issue #11180 Gap B), so ONLY the SDK backends map to a rotation agent type.
 */
const BACKEND_TO_AGENT_TYPE: Readonly<Record<string, RotationAgentType>> = {
  "claude-sdk": "claude",
  "codex-sdk": "codex",
};

/** Map an inference backend to the coding-agent pool type, or null when unrotatable. */
export function rotationAgentTypeForBackend(backend: string): RotationAgentType | null {
  return BACKEND_TO_AGENT_TYPE[backend] ?? null;
}

/** Default cool-off applied to an account that hit a subscription limit (15 min). */
export const ROTATION_RATE_LIMIT_COOLOFF_MS = 15 * 60_000;

/**
 * True when this error is the subscription-limit / rate-limit class that should
 * trigger account rotation. Deliberately CONSERVATIVE: the session handlers
 * already narrow their throws (they only surface the limit envelope as a
 * "subscription rate limit reached: …" message, or a `ProviderApiError` whose
 * message carries the upstream status), so we anchor on those same signals plus
 * a 429/529/quota vocabulary. A false positive burns a healthy account out of
 * the pool for 15 min, so anything ambiguous (400, empty completion, plain auth
 * failure, generic timeout) does NOT rotate — it rethrows to failover.
 */
export function isSubscriptionLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === "number" && (statusCode === 429 || statusCode === 529)) {
    return true;
  }
  const t = message.toLowerCase();
  return (
    // The claude-sdk session's own limit throw ("subscription rate limit reached: …").
    t.includes("subscription rate limit reached") ||
    // Explicit status the SDK envelope carries.
    /\b(429|529)\b/.test(t) ||
    // Provider limit / quota vocabulary. Kept tight: "rate limit" + "usage limit
    // reached" + "quota exceeded/exhausted" + "too many requests" are the
    // unambiguous provider signals (matches the orchestrator's classifier).
    /rate[\s-]?limit(?:ed|ing)?/.test(t) ||
    t.includes("usage limit reached") ||
    /quota (?:exceeded|exhausted)/.test(t) ||
    // OpenAI's CLASSIC quota envelope inverts the word order ("You exceeded
    // your current quota, please check your plan and billing details") and
    // carries the machine code `insufficient_quota` — none of which contain
    // "quota exceeded" or a literal 429. Anchor on the provider's exact
    // envelope phrases / error code, NOT generic quota/billing prose, so a
    // model merely talking about quotas still does not rotate.
    t.includes("exceeded your current quota") ||
    t.includes("check your plan and billing details") ||
    t.includes("insufficient_quota") ||
    t.includes("too many requests")
  );
}

/** Resolve whether rotation is enabled (default ON; opt-out via env/setting). */
export function rotationEnabled(getValue: (key: string) => string | undefined): boolean {
  const raw = getValue("ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION")?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

/**
 * The only auth vars each first-party SDK subprocess may receive. The child
 * starts from the same narrow process-launch allowlist as the cold CLI path;
 * host secrets for unrelated providers never cross this boundary.
 */
const BACKEND_AUTH_VARS: Readonly<Record<RotationAgentType, readonly string[]>> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY"],
};

function safeBaseSubprocessEnv(): RotationSubprocessEnv {
  return typeof process === "undefined" ? {} : filterEnv(process.env);
}

function validateBackendAuthPatch(
  agentType: RotationAgentType,
  envPatch: Record<string, string>
): void {
  const allowed = new Set(BACKEND_AUTH_VARS[agentType]);
  const entries = Object.entries(envPatch);
  if (entries.length === 0) {
    throw new Error(`[cli-inference:rotation] selected ${agentType} account has no auth env`);
  }
  for (const [key, value] of entries) {
    if (!allowed.has(key)) {
      throw new Error(
        `[cli-inference:rotation] refusing unexpected ${agentType} auth env key ${JSON.stringify(key)}`
      );
    }
    if (!value.trim()) {
      throw new Error(`[cli-inference:rotation] selected ${agentType} account has an empty ${key}`);
    }
  }
}

/**
 * Build the least-privilege environment for the machine's ambient SDK login.
 * Only process-launch essentials plus this backend's canonical auth variables
 * cross the subprocess boundary; credentials for other providers do not.
 */
export function buildAmbientSubprocessEnv(agentType: RotationAgentType): RotationSubprocessEnv {
  const env = safeBaseSubprocessEnv();
  if (typeof process === "undefined") return env;
  for (const key of BACKEND_AUTH_VARS[agentType]) {
    const value = process.env[key];
    if (value?.trim()) env[key] = value;
  }
  return env;
}

/**
 * Build the SDK subprocess env for a rotated account. Pure: it never mutates
 * `process.env`, so pooled credentials cannot leak into the parent process or
 * other in-process consumers.
 */
export function buildRotatedSubprocessEnv(
  agentType: RotationAgentType,
  envPatch: Record<string, string>
): RotationSubprocessEnv {
  validateBackendAuthPatch(agentType, envPatch);
  const env = safeBaseSubprocessEnv();
  return { ...env, ...envPatch };
}

/** A description safe to log about a selection (label + provider, NEVER the token). */
function safeAccountLabel(sel: RotationAccountSelection): string {
  return `${sel.providerId}/${sel.label}`;
}

/** Persist account affinity without retaining the materialized auth secret. */
function rotationState(
  bridge: CodingAgentSelectorBridge,
  selection: RotationAccountSelection
): RotationState {
  return {
    bridge,
    selection: {
      providerId: selection.providerId,
      accountId: selection.accountId,
      label: selection.label,
      source: selection.source,
      strategy: selection.strategy,
    },
  };
}

export interface RotationContext {
  /** The configured inference backend (claude-sdk / codex-sdk / claude / codex). */
  backend: string;
  /** Read a runtime setting/env value (rotation gate). */
  getValue: (key: string) => string | undefined;
  /** Stable key so pool session-affinity ties a conversation to one account. */
  sessionKey?: string;
  /** Runtime-owned identity boundary and optional diagnostic reporter. */
  scope: object & {
    reportError?: (scope: string, error: unknown, context?: Record<string, unknown>) => void;
  };
  /** Selection strategy override (else the pool's default). */
  strategy?: CodingAccountStrategy;
}

type KeyedRotationContext = RotationContext & { sessionKey: string };

function reportRotationBookkeepingFailure(
  ctx: RotationContext,
  operation: "record-usage" | "mark-rate-limited",
  error: unknown
): void {
  logger.warn(
    {
      src: "cli-inference:rotation",
      backend: ctx.backend,
      operation,
    },
    `[cli-inference] subscription account ${operation} bookkeeping failed`
  );
  try {
    ctx.scope.reportError?.("cli-inference.account-rotation", error, {
      backend: ctx.backend,
      operation,
    });
  } catch {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — custom runtime-like
    // scopes may violate reportError's no-throw contract; warn without recursing.
    logger.warn(
      {
        src: "cli-inference:rotation",
        backend: ctx.backend,
        operation,
        reason: "report-error-failed",
      },
      "[cli-inference] runtime rejected an account-bookkeeping diagnostic"
    );
  }
}

function rotationStateKey(ctx: KeyedRotationContext): string {
  return `${ctx.backend}\u001f${ctx.sessionKey}`;
}

/** Missing affinity must isolate this call, never create a runtime-global lane. */
function withRequestSessionKey(ctx: RotationContext): KeyedRotationContext {
  const sessionKey = ctx.sessionKey?.trim();
  return {
    ...ctx,
    sessionKey: sessionKey || `cli-inference:${ctx.backend}:request:${randomUUID()}`,
  };
}

function stateStore(ctx: RotationContext): Map<string, RotationState> {
  let store = scopedRotationState.get(ctx.scope);
  if (!store) {
    store = new Map<string, RotationState>();
    scopedRotationState.set(ctx.scope, store);
  }
  return store;
}

/** Conversation pins are bounded; eviction safely falls back to pool selection. */
function storeRotationState(
  store: Map<string, RotationState>,
  key: string,
  state: RotationState
): void {
  store.delete(key);
  store.set(key, state);
  while (store.size > MAX_ROTATION_STATE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) return;
    store.delete(oldest);
  }
}

function chainStore(ctx: RotationContext): Map<string, Promise<void>> {
  let store = scopedRotationChains.get(ctx.scope);
  if (!store) {
    store = new Map<string, Promise<void>>();
    scopedRotationChains.set(ctx.scope, store);
  }
  return store;
}

function enqueueRotation<T>(ctx: KeyedRotationContext, runLocked: () => Promise<T>): Promise<T> {
  const key = rotationStateKey(ctx);
  const store = chainStore(ctx);
  const previous = store.get(key) ?? Promise.resolve();
  const run = previous.then(runLocked, runLocked);
  // error-policy:J5 the tail is only the per-runtime rotation mutex. The real
  // result and rejection are returned through `run`; this settled tail prevents
  // an unhandled rejection while allowing the next request to acquire the lock.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  store.set(key, tail);
  void tail.finally(() => {
    if (store.get(key) === tail) store.delete(key);
  });
  return run;
}

/** Test seam: keeps per-test rotation state independent. */
export function resetRotationStateForTests(): void {
  scopedRotationState = new WeakMap<object, Map<string, RotationState>>();
  scopedRotationChains = new WeakMap<object, Map<string, Promise<void>>>();
}

/**
 * Run `attempt` with pool-first auth + transparent account rotation on
 * subscription-limit errors.
 *
 * Flow:
 *  1. Pool-FIRST initial auth: when no account is selected for this session yet,
 *     select a healthy pooled account BEFORE the first attempt so a stored
 *     app-connected subscription serves the very first turn. Empty pool / failed
 *     selection → ambient fallback through a backend-specific safe env.
 *  2. Try `attempt(env)`. On success, return it (and best-effort record usage on
 *     the currently-selected account).
 *  3. If it throws and the error is NOT a subscription-limit (or rotation is
 *     disabled / no bridge / backend not rotatable), rethrow immediately →
 *     the caller's existing provider-failover chain handles it.
 *  4. On a limit error: mark the current account rate-limited, select the next
 *     healthy account from the pool (excluding every account already tried),
 *     build its subprocess-only env, and retry in a fresh SDK process. Repeat
 *     until an attempt succeeds or the pool is exhausted; when the pool returns
 *     null, rethrow the LAST limit error so failover runs.
 *
 * A single structured `warn` is emitted per rotation (no credential/envelope
 * leakage). At most `maxRotations` swaps are attempted to bound the loop even if
 * the pool mis-reports health.
 */
export async function withAccountRotation(
  attempt: (env?: RotationSubprocessEnv) => Promise<string>,
  ctx: RotationContext,
  maxRotations = 8
): Promise<string> {
  const agentType = rotationAgentTypeForBackend(ctx.backend);
  const bridge = agentType ? getCodingAccountBridge() : null;
  // Cold backends already apply their own child-env filter and do not use this
  // SDK-specific account path.
  if (!agentType) {
    return attempt();
  }
  const ambientEnv = buildAmbientSubprocessEnv(agentType);
  if (!bridge || !rotationEnabled(ctx.getValue)) {
    return attempt(ambientEnv);
  }

  const keyedContext = withRequestSessionKey(ctx);
  return enqueueRotation(keyedContext, async () => {
    const stateKey = rotationStateKey(keyedContext);
    const states = stateStore(keyedContext);
    let state = states.get(stateKey) ?? null;
    let subprocessEnv: RotationSubprocessEnv | undefined;
    if (state && state.bridge !== bridge) {
      states.delete(stateKey);
      state = null;
    }

    // A fresh SDK query/process must not reuse an old materialized access token.
    // Re-resolve the exact selected account on every call; `accountIds` preserves
    // affinity while allowing the bridge to refresh tokens or CODEX_HOME safely.
    if (state) {
      const selectedAccountId = state.selection.accountId;
      const refreshed = await bridge.select(agentType, {
        sessionKey: keyedContext.sessionKey,
        ...(ctx.strategy ? { strategy: ctx.strategy } : {}),
        accountIds: [selectedAccountId],
      });
      if (refreshed) {
        if (refreshed.accountId !== selectedAccountId) {
          throw new Error(
            `[cli-inference:rotation] pinned ${agentType} account changed from ${selectedAccountId} to ${refreshed.accountId}`
          );
        }
        subprocessEnv = buildRotatedSubprocessEnv(agentType, refreshed.envPatch);
        state = rotationState(bridge, refreshed);
        storeRotationState(states, stateKey, state);
      } else {
        states.delete(stateKey);
        state = null;
      }
    }

    // Pool-first initial auth: nothing selected for this session yet, so ask the
    // pool BEFORE the first attempt instead of silently starting on the machine's
    // ambient credential. An app user who connected their subscription expects it
    // used immediately — and a machine with NO ambient login would otherwise fail
    // despite a healthy pooled account. Ambient stays the fallback: select → null
    // (empty pool) or a selection error changes nothing.
    if (!state) {
      let selection: RotationAccountSelection | null = null;
      try {
        selection = await bridge.select(agentType, {
          sessionKey: keyedContext.sessionKey,
          ...(ctx.strategy ? { strategy: ctx.strategy } : {}),
        });
      } catch {
        // error-policy:J4 explicit degrade — the account POOL is optional; if its
        // select() fails we fall back to the ambient credential (documented degrade),
        // the CLI still runs. Not a swallowed inference failure.
        logger.warn(
          {
            src: "cli-inference:rotation",
            backend: ctx.backend,
            reason: "initial-select-failed",
          },
          "[cli-inference] initial pool selection failed — falling back to the ambient credential"
        );
      }
      if (selection) {
        subprocessEnv = buildRotatedSubprocessEnv(agentType, selection.envPatch);
        state = rotationState(bridge, selection);
        storeRotationState(states, stateKey, state);
        logger.info(
          {
            src: "cli-inference:rotation",
            backend: ctx.backend,
            account: safeAccountLabel(selection),
            strategy: selection.strategy,
          },
          `[cli-inference] pooled ${agentType} account selected for SDK auth`
        );
      }
    }

    const tried: string[] = state ? [state.selection.accountId] : [];
    let lastError: unknown;

    for (let rotations = 0; rotations <= maxRotations; rotations += 1) {
      try {
        const result = await attempt(subprocessEnv ?? ambientEnv);
        // Record a successful call against the account we rotated INTO so
        // quota-aware selection reflects real usage (best-effort; never throws).
        if (state) {
          void bridge
            // error-policy:J7 usage accounting is telemetry — a recordUsage failure
            // must not fail the successful inference result, but remains observable.
            .recordUsage(state.selection.providerId, state.selection.accountId, { ok: true })
            .catch((error) => reportRotationBookkeepingFailure(ctx, "record-usage", error));
        }
        return result;
      } catch (err) {
        lastError = err;
        if (!isSubscriptionLimitError(err)) {
          // Not a limit — a genuine failure. Do NOT rotate (would burn a healthy
          // account); rethrow so the caller's provider-failover chain runs.
          throw err;
        }
        // The active account just limited. Mark it (with its reset window) so
        // quota-aware selection routes around it, then pick the next healthy one.
        // Only for an account WE selected (the ambient credential is untracked).
        if (state) {
          void bridge
            // error-policy:J7 marking the limit is best-effort bookkeeping; failure
            // to persist it must not stop rotation, but remains observable.
            .markRateLimited(
              state.selection.providerId,
              state.selection.accountId,
              Date.now() + ROTATION_RATE_LIMIT_COOLOFF_MS,
              "cli-inference subscription limit"
            )
            .catch((error) => reportRotationBookkeepingFailure(ctx, "mark-rate-limited", error));
          states.delete(stateKey);
          state = null;
          subprocessEnv = undefined;
        }

        // `maxRotations` counts account swaps after the initial attempt. Do not
        // select and retain a credential that this call will never try.
        if (rotations >= maxRotations) throw err;

        let selection: RotationAccountSelection | null = null;
        try {
          selection = await bridge.select(agentType, {
            sessionKey: keyedContext.sessionKey,
            ...(ctx.strategy ? { strategy: ctx.strategy } : {}),
            // Copy: `tried` keeps growing across rotations; the bridge must see
            // the exclusions as of THIS call, not a live reference.
            exclude: [...tried],
          });
        } catch {
          // error-policy:J4 explicit degrade — an unavailable optional account
          // pool yields to provider failover by rethrowing the original limit.
          logger.warn(
            {
              src: "cli-inference:rotation",
              backend: ctx.backend,
              reason: "select-failed",
            },
            "[cli-inference] account rotation select failed — falling through to provider failover"
          );
          throw err;
        }

        if (!selection) {
          // Pool exhausted: every healthy account tried, or none configured.
          // Rethrow the limit error so the caller's failover chain (cloud / API)
          // runs — rotation composes with, and yields to, failover.
          logger.warn(
            {
              src: "cli-inference:rotation",
              backend: ctx.backend,
              tried: tried.length,
              reason: "pool-exhausted",
            },
            `[cli-inference] all pooled ${agentType} accounts rate-limited (${tried.length} tried) — failing over to next provider tier`
          );
          throw err;
        }

        if (tried.includes(selection.accountId)) {
          throw new Error(
            `[cli-inference:rotation] ${agentType} account selector returned an excluded account`
          );
        }

        tried.push(selection.accountId);
        subprocessEnv = buildRotatedSubprocessEnv(agentType, selection.envPatch);
        state = rotationState(bridge, selection);
        storeRotationState(states, stateKey, state);
        logger.warn(
          {
            src: "cli-inference:rotation",
            backend: ctx.backend,
            account: safeAccountLabel(selection),
            strategy: selection.strategy,
            attempt: rotations + 1,
          },
          `[cli-inference] rotated to next ${agentType} account after subscription limit`
        );
        // loop retries the turn on the new account
      }
    }

    // Exhausted maxRotations without success — fail over with the last error.
    throw lastError instanceof Error
      ? lastError
      : new Error(`[cli-inference] account rotation exhausted: ${String(lastError)}`);
  });
}
