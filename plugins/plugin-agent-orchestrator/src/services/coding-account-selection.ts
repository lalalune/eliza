/**
 * Orchestrator-side reader for the coding-agent account-selector bridge.
 *
 * The bridge itself lives in `@elizaos/app-core` (it owns the `AccountPool` and
 * the credential store). This plugin depends only on `@elizaos/core`, so — like
 * the parent-context bridge — it reads the contract off a `globalThis` symbol
 * rather than importing app-core. When no pool/accounts are configured the
 * bridge is absent and every helper here no-ops, leaving the single-account
 * behavior untouched. Ordinary selection never throws; durable recovery can
 * opt into strict mode so a credential-materialization failure remains visible
 * and cannot be mistaken for permission to inherit host credentials.
 */

import { isTokenExpiryText } from "@elizaos/auth";
import {
  type CodingAccountStrategy,
  type CodingAccountUsage,
  type CodingAgentSelection,
  type CodingAgentSelectorBridge,
  type CodingProviderAvailability,
  ElizaError,
  getCodingAgentSelectorBridge,
  logger,
} from "@elizaos/core";

// The bridge symbol + contract are single-sourced in `@elizaos/core`; re-export
// the shared types under this plugin's public surface. `CodingAccountSelection`
// is the orchestrator's historical name for the bridge selection payload.
export type {
  CodingAccountStrategy,
  CodingAccountUsage,
  CodingProviderAvailability,
};
export type CodingAccountSelection = CodingAgentSelection;

/** Non-secret account descriptor stamped onto the session record. */
export interface CodingAccountMeta {
  providerId: string;
  accountId: string;
  label: string;
  source: string;
  strategy: string;
}

export interface ResolvedCodingAccount {
  selection: CodingAccountSelection;
  meta: CodingAccountMeta;
}

/**
 * Non-secret recovery pin retained after an unavailable pooled account is
 * removed from live billing attribution. Durable recovery reads this key so a
 * later restart cannot reinterpret the session as an unpooled host-auth spawn.
 */
export const POOLED_ACCOUNT_RECOVERY_METADATA_KEY = "pooledAccountRecovery";

/** Typed failure raised before a recovery spawn can inherit host credentials. */
export const POOLED_ACCOUNT_RECOVERY_UNAVAILABLE_CODE =
  "ACP_POOLED_ACCOUNT_RECOVERY_UNAVAILABLE";

/** A configured account pool could not supply an account for a fresh spawn. */
export const POOLED_ACCOUNT_UNAVAILABLE_CODE = "ACP_POOLED_ACCOUNT_UNAVAILABLE";

/**
 * Agent types that authenticate per pooled account. claude and codex are
 * first-party CLIs; opencode pool-rotates across `cerebras-api` accounts (the
 * one backend it resolves from a pooled key — its injected CEREBRAS_API_KEY is
 * read by buildOpencodeSpawnConfig). elizaos/pi-agent authenticate through their
 * own backend, and z.ai/Kimi/GLM have no first-party coding CLI. Keep this in
 * sync with the app-core bridge's AGENT_PROVIDER_CANDIDATES.
 */
const MULTI_ACCOUNT_AGENT_TYPES = new Set(["claude", "codex", "opencode"]);

export function isMultiAccountAgentType(agentType: string): boolean {
  return MULTI_ACCOUNT_AGENT_TYPES.has(agentType.toLowerCase());
}

export function getCodingAccountBridge(): CodingAgentSelectorBridge | null {
  return getCodingAgentSelectorBridge();
}

/**
 * Return the number of linked accounts for a multi-account agent, or null when
 * no pool bridge applies. A bridge inspection failure throws because callers
 * must not interpret an unknown pool as permission to inherit host credentials.
 */
export function configuredCodingAccountCount(agentType: string): number | null {
  if (!isMultiAccountAgentType(agentType)) return null;
  const bridge = getCodingAccountBridge();
  if (!bridge) return null;
  try {
    const described = bridge.describe();
    const rows = described[agentType.toLowerCase()] ?? [];
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !row ||
          typeof row !== "object" ||
          !Number.isSafeInteger(row.total) ||
          row.total < 0,
      )
    ) {
      throw new TypeError("Coding-account availability is malformed");
    }
    return rows.reduce((sum, row) => sum + row.total, 0);
  } catch (cause) {
    // error-policy:J2 account-pool inspection is part of the spawn credential
    // boundary; preserve the bridge failure so the caller fails closed.
    throw new ElizaError(
      `Could not verify the configured pooled accounts for ${agentType}`,
      {
        code: POOLED_ACCOUNT_UNAVAILABLE_CODE,
        cause,
        context: { agentType },
        severity: "ephemeral",
      },
    );
  }
}

export function resolveCodingAccountStrategy(
  raw: string | undefined,
): CodingAccountStrategy | undefined {
  const value = raw?.trim().toLowerCase();
  if (
    value === "priority" ||
    value === "round-robin" ||
    value === "least-used" ||
    value === "quota-aware" ||
    value === "reset-soonest" ||
    value === "drain-soonest-reset"
  ) {
    return value;
  }
  return undefined;
}

function toMeta(selection: CodingAccountSelection): CodingAccountMeta {
  return {
    providerId: selection.providerId,
    accountId: selection.accountId,
    label: selection.label,
    source: selection.source,
    strategy: selection.strategy,
  };
}

/**
 * Pick an account for a coding sub-agent. Returns null (single-account
 * fallback) when the bridge is absent, the agent type is not multi-account, or
 * no eligible account exists. `strict` preserves bridge failures for durable
 * recovery; ordinary calls retain the designed single-account degradation.
 */
export async function selectCodingAccount(
  agentType: string,
  opts: {
    sessionKey?: string;
    strategy?: CodingAccountStrategy;
    exclude?: string[];
    /** Pin selection to these account ids (see the bridge contract in core). */
    accountIds?: string[];
    /** Requested model/display name for model-scoped weekly buckets. */
    model?: string;
    /** Recovery boundaries preserve selector/materialization failures. */
    strict?: boolean;
  } = {},
): Promise<ResolvedCodingAccount | null> {
  if (!isMultiAccountAgentType(agentType)) return null;
  const bridge = getCodingAccountBridge();
  if (!bridge) return null;
  const { strict, ...bridgeOpts } = opts;
  let selection: CodingAccountSelection | null = null;
  try {
    selection = await bridge.select(agentType, bridgeOpts);
  } catch (cause) {
    if (strict) {
      // error-policy:J2 durable recovery must retain the bridge/materialization
      // failure instead of converting it into the ordinary host-auth fallback.
      throw new ElizaError(
        `Pooled account selection failed for ${agentType} durable recovery`,
        {
          code: POOLED_ACCOUNT_RECOVERY_UNAVAILABLE_CODE,
          cause,
          context: { agentType, accountIds: opts.accountIds },
          severity: "ephemeral",
        },
      );
    }
    // error-policy:J4 designed degrade — a select fault degrades to
    // single-account (null); the degraded-vs-benign distinction is surfaced to
    // operators by diagnoseCodingAccountFallback (#9960), not swallowed here.
    return null;
  }
  if (!selection) return null;
  return { selection, meta: toMeta(selection) };
}

/**
 * Explain a single-account fallback loudly, or return null when the fallback is
 * benign. `selectCodingAccount` correctly returns null (→ single-account) whether
 * the pool is empty by design or degraded by a transient fault — but those two
 * cases must not look the same to an operator. This surfaces ONLY the degraded
 * case (#9960's "a misconfigured pool silently degrades to single-account"):
 * a multi-account agent type that has accounts connected but none healthy, so
 * the spawn is about to run on single-account credentials nobody chose.
 *
 * Benign (returns null, no warning): not a multi-account agent type, no bridge
 * (single-account host), or zero accounts connected (single-account by choice).
 */
export function diagnoseCodingAccountFallback(
  agentType: string,
): string | null {
  if (!isMultiAccountAgentType(agentType)) return null;
  const bridge = getCodingAccountBridge();
  if (!bridge) return null;
  let rows: CodingProviderAvailability[];
  try {
    rows = bridge.describe()[agentType.toLowerCase()] ?? [];
  } catch {
    // error-policy:J4 designed degrade — if the pool cannot be described there
    // is no healthy/total signal to diagnose, so no false single-account
    // warning is raised (benign path returns null; see header).
    return null;
  }
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  const healthy = rows.reduce((sum, r) => sum + r.healthy, 0);
  if (total === 0) return null;
  if (healthy === 0) {
    return (
      `${agentType}: ${total} account(s) connected but 0 healthy — ` +
      "spawning with single-account credentials. Reconnect or clear the " +
      "rate-limit / needs-reauth state in Settings → AI models (or the " +
      "in-chat account panel)."
    );
  }
  return null;
}

/**
 * Whether the pool still has ≥1 healthy pooled account for this agent type —
 * the gate the router's in-router account failover and the task service's
 * crash-termination decision BOTH consult, so "will a spawned account failure
 * be respawned onto a sibling?" is answered in one place. False when the bridge
 * is absent (single-account host) or the pool is fully exhausted; in that case
 * there is no sibling to fail over to, so the crash is un-respawnable and the
 * task must terminate rather than park waiting for a respawn that will never
 * come. Fails safe to false on a probe error.
 */
export function hasHealthyPooledAccount(agentType: string): boolean {
  const bridge = getCodingAccountBridge();
  if (!bridge) return false;
  try {
    const rows = bridge.describe()[agentType.toLowerCase()] ?? [];
    return rows.some((row) => row.healthy > 0);
  } catch {
    // error-policy:J3 account-bridge probe failure → fail-safe "no healthy
    // account"; declines failover so the task's honest failure reaches the user.
    return false;
  }
}

/**
 * Per-agent-type readiness verdict: how many healthy pooled accounts back this
 * coding agent vs. how many the requested posture needs.
 */
export interface CodingProviderReadiness {
  agentType: string;
  total: number;
  enabled: number;
  healthy: number;
  required: number;
  ok: boolean;
}

/** The pool's readiness for live coding work, with loud-failure detail. */
export interface CodingAccountReadiness {
  ready: boolean;
  /** True when ≥2 healthy accounts per provider are required (local rotation). */
  rotation: boolean;
  /** Healthy accounts required per agent type (1 normally, 2 for rotation). */
  required: number;
  providers: CodingProviderReadiness[];
  /** Human-readable reasons the pool is not ready (empty when ready). */
  problems: string[];
}

/** The agent types the live multi-account orchestrator depends on. */
export const READINESS_REQUIRED_AGENT_TYPES = ["claude", "codex"] as const;

/**
 * Pure: assess whether the account pool has enough healthy accounts to run the
 * multi-account coding orchestrator. The orchestrator's per-spawn
 * `selectCodingAccount` silently falls back to single-account when the pool is
 * thin (the correct runtime behavior — a degraded pool must not hard-fail a
 * spawn). This function is the loud counterpart: a CI/ops gate that asserts
 * ≥1 healthy Codex AND ≥1 healthy Claude (≥2 each with `rotation`) so a
 * misconfigured pool is caught explicitly instead of degrading invisibly.
 */
export function assessCodingAccountReadiness(
  availability: Record<string, CodingProviderAvailability[]>,
  opts: { rotation?: boolean; agentTypes?: readonly string[] } = {},
): CodingAccountReadiness {
  const rotation = opts.rotation ?? false;
  const required = rotation ? 2 : 1;
  const agentTypes = opts.agentTypes ?? READINESS_REQUIRED_AGENT_TYPES;
  const providers: CodingProviderReadiness[] = [];
  const problems: string[] = [];
  for (const agentType of agentTypes) {
    const rows = availability[agentType] ?? [];
    const total = rows.reduce((sum, r) => sum + r.total, 0);
    const enabled = rows.reduce((sum, r) => sum + r.enabled, 0);
    const healthy = rows.reduce((sum, r) => sum + r.healthy, 0);
    const ok = healthy >= required;
    providers.push({ agentType, total, enabled, healthy, required, ok });
    if (!ok) {
      problems.push(
        `${agentType}: ${healthy} healthy account(s), need >= ${required}` +
          (total === 0 ? " (none connected)" : ` (${total} connected)`),
      );
    }
  }
  return {
    ready: problems.length === 0,
    rotation,
    required,
    providers,
    problems,
  };
}

export type CodingAccountFailureKind = "rate-limited" | "needs-reauth";

/** Default cool-off applied to a rate-limited account (15 min). */
export const RATE_LIMIT_COOLOFF_MS = 15 * 60_000;

// Conservative classifiers: require an UNAMBIGUOUS provider auth/quota signal,
// never a bare "api key" / "login" token (those appear in ordinary build
// output). A false positive evicts a HEALTHY account from the pool, so the bar
// is intentionally high.
// "exceeded your current quota" / "check your plan and billing details" /
// `insufficient_quota` = OpenAI's CLASSIC quota envelope ("You exceeded your
// current quota, please check your plan and billing details"), which contains
// neither "quota exceeded" (inverted word order) nor a literal 429. Exact
// envelope phrases / error code only — generic quota/billing prose must NOT
// match. Keep in lockstep with plugin-cli-inference's isSubscriptionLimitError.
const RATE_LIMIT_RE =
  /\b429\b|rate[\s-]?limit(?:ed|ing)?|too many requests|quota (?:exceeded|exhausted)|exceeded your current quota|check your plan and billing details|insufficient_quota|usage limit reached/i;
const NEEDS_REAUTH_RE =
  /\b401\b|\b403\b|unauthorized|invalid_grant|authentication failed|token (?:has )?expired|expired token|invalid token|please (?:re-?authenticate|log ?in again)/i;

/**
 * Pure: classify a sub-agent error message as a pooled-account failure, or null
 * when it is an ordinary task error. Rate-limit is checked first (a 429 is a
 * cool-off, not a credential problem).
 */
export function classifyAccountFailure(
  text: string | undefined | null,
): CodingAccountFailureKind | null {
  if (!text) return null;
  if (RATE_LIMIT_RE.test(text)) return "rate-limited";
  if (NEEDS_REAUTH_RE.test(text)) return "needs-reauth";
  return null;
}

export { isTokenExpiryText };

/**
 * Best-effort: tell the pool a spawned account hit a rate-limit / needs reauth
 * so the selector stops handing it out (and the readiness gate + account-health
 * panel reflect it) instead of the failure being swallowed and the same dud
 * account re-selected. No-op when no bridge or no account; never throws.
 */
export async function reportCodingAccountFailure(
  meta: CodingAccountMeta | null,
  kind: CodingAccountFailureKind,
  nowMs: number,
  detail?: string,
): Promise<void> {
  if (!meta) return;
  const bridge = getCodingAccountBridge();
  if (!bridge) return;
  try {
    if (kind === "rate-limited") {
      await bridge.markRateLimited(
        meta.providerId,
        meta.accountId,
        nowMs + RATE_LIMIT_COOLOFF_MS,
        detail,
      );
    } else {
      await bridge.markNeedsReauth(meta.providerId, meta.accountId, detail);
    }
  } catch (err) {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — pool feedback is
    // best-effort so a failed mark must not break the error path already
    // surfacing the underlying problem, but a silently-lost mark means the
    // selector keeps handing out the dud account. This module has no runtime
    // handle to call runtime.reportError; the caller (sub-agent-router) does
    // and observes the failover itself, so warn via the structured logger to
    // make the lost mark observable instead of swallowing it.
    logger.warn(
      {
        src: "acpx:coding-account-selection",
        providerId: meta.providerId,
        accountId: meta.accountId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      },
      "[CodingAccountSelection] failed to record account failure",
    );
  }
}

function codingAccountMeta(value: unknown): CodingAccountMeta | null {
  const account = value;
  if (!account || typeof account !== "object") return null;
  const a = account as Record<string, unknown>;
  if (typeof a.providerId !== "string" || typeof a.accountId !== "string") {
    return null;
  }
  const providerId = a.providerId.trim();
  const accountId = a.accountId.trim();
  if (!providerId || !accountId) return null;
  const label = typeof a.label === "string" ? a.label.trim() : "";
  const source = typeof a.source === "string" ? a.source.trim() : "";
  const strategy = typeof a.strategy === "string" ? a.strategy.trim() : "";
  return {
    providerId,
    accountId,
    label: label || accountId,
    source: source || (providerId.endsWith("-api") ? "api-key" : "oauth"),
    strategy: strategy || "least-used",
  };
}

/** Read the account descriptor previously stamped onto a session's metadata. */
export function accountMetaFromSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): CodingAccountMeta | null {
  return codingAccountMeta(metadata?.account);
}

/** Read the fail-closed pooled-account pin retained for durable recovery. */
export function recoveryAccountMetaFromSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): CodingAccountMeta | null {
  return codingAccountMeta(metadata?.[POOLED_ACCOUNT_RECOVERY_METADATA_KEY]);
}

/**
 * Remove live account attribution while retaining the non-secret identity that
 * every later recovery attempt must pin. This prevents a revoked account from
 * becoming an implicit host-auth session on the next restart.
 */
export function retainPooledAccountRecoveryRequirement(
  metadata: Record<string, unknown> | undefined,
  meta: CodingAccountMeta,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...(metadata ?? {}),
    [POOLED_ACCOUNT_RECOVERY_METADATA_KEY]: meta,
  };
  delete next.account;
  return next;
}
