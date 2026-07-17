/**
 * Cross-checks completion file claims against recorded ACP tool outcomes.
 * The task service blocks unsupported claims, while AcpService reuses the path
 * extraction contract so change capture and verification cannot drift.
 */

// Both AcpService change capture and the completion verifier call the helpers
// below, keeping this adapter-specific vocabulary at one boundary.
const EDIT_PATH_KEYS = [
  "filePath",
  "file_path",
  "path",
  "file",
  "target",
  "abspath",
] as const;

const WRITE_CONTENT_KEYS = [
  "content",
  "contents",
  "new_string",
  "newText",
  "patch",
  "diff",
] as const;

const MUTATING_TOOL_KINDS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "create",
  "patch",
  "move",
  "delete",
]);

/** Tool-call fields needed to classify a file mutation and extract its paths. */
export interface FileMutationToolCall {
  kind?: unknown;
  rawInput?: unknown;
  locations?: unknown;
}

/** Minimal shape of a recorded orchestrator task event this module reads. */
export interface ToolLedgerEvent {
  eventType: string;
  data: Record<string, unknown>;
}

/** Fold of every mutating tool call in the session's recorded events. */
export interface WriteLedger {
  /** Paths written by a call whose LAST recorded status is `completed`. */
  verified: ReadonlySet<string>;
  /** Paths whose only writers terminally `failed`/`error`ed. */
  rejected: ReadonlySet<string>;
  /** Paths whose writers never reached a recorded terminal status. */
  indeterminate: ReadonlySet<string>;
  /** False when the events contain no mutating tool call at all — the
   *  adapter did not produce a structured ledger, so nothing is auditable. */
  observed: boolean;
}

type UnverifiedClaimReason = "rejected-write" | "no-write-observed";

/** One completion path that lacks a successful write outcome. */
export interface UnverifiedFileClaim {
  path: string;
  reason: UnverifiedClaimReason;
}

/** Claim partition produced from one session's write ledger. */
export interface ClaimedFileVerdict {
  /** Claims backed by a successful ledger write. */
  verifiedClaims: string[];
  /** Claims with no successful ledger write, fail-closed labelled. */
  unverifiedClaims: UnverifiedFileClaim[];
  /** Mirrors {@link WriteLedger.observed}; when false the verdict is
   *  non-actionable and must not be rendered. */
  ledgerObserved: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function normalizePath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** Whether a structured tool call carries a file-mutation signal. */
export function isMutatingFileToolCall(
  toolCall: FileMutationToolCall,
): boolean {
  const kind = (str(toolCall.kind) ?? "").toLowerCase();
  if (MUTATING_TOOL_KINDS.has(kind)) return true;
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  return WRITE_CONTENT_KEYS.some((key) => key in rawInput);
}

/** Collect normalized target paths from a structured file-mutation call. */
export function collectFileMutationPaths(
  toolCall: FileMutationToolCall,
): string[] {
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const paths: string[] = [];
  for (const key of EDIT_PATH_KEYS) {
    const value = str(rawInput[key]);
    if (value) paths.push(normalizePath(value));
  }
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  for (const location of locations) {
    if (!isRecord(location)) continue;
    const value = str(location.path);
    if (value) paths.push(normalizePath(value));
  }
  return paths;
}

/**
 * Fold recorded `tool_running`/`tool_result` events into a write ledger.
 * Events for one tool call arrive as a series (initial submission, enriched
 * updates, terminal status); the LAST recorded status per call id wins, and
 * the call's path set is the union across its updates (the initial
 * submission often has an empty `rawInput`, enriched later).
 */
export function extractWriteLedger(events: ToolLedgerEvent[]): WriteLedger {
  const byCall = new Map<string, { paths: Set<string>; status?: string }>();
  let anonymousIndex = 0;
  for (const event of events) {
    if (
      event.eventType !== "tool_running" &&
      event.eventType !== "tool_result"
    ) {
      continue;
    }
    const toolCall = isRecord(event.data.toolCall)
      ? event.data.toolCall
      : event.data;
    if (!isMutatingFileToolCall(toolCall)) continue;
    // A call without an id cannot be folded across updates; give it a unique
    // slot so its own status still classifies its paths.
    const id = str(toolCall.id) ?? `__anonymous_${anonymousIndex++}`;
    const entry = byCall.get(id) ?? { paths: new Set<string>() };
    for (const path of collectFileMutationPaths(toolCall))
      entry.paths.add(path);
    const status = (str(toolCall.status) ?? "").toLowerCase();
    if (status) entry.status = status;
    byCall.set(id, entry);
  }

  const verified = new Set<string>();
  const rejected = new Set<string>();
  const indeterminate = new Set<string>();
  for (const { paths, status } of byCall.values()) {
    const bucket =
      status === "completed"
        ? verified
        : status === "failed" || status === "error"
          ? rejected
          : indeterminate;
    for (const path of paths) bucket.add(path);
  }
  // A path is verified as soon as ONE writer completed, whatever other
  // attempts did (a failed first try followed by a successful retry is the
  // normal shape of the stale-write guard doing its job).
  for (const path of verified) {
    rejected.delete(path);
    indeterminate.delete(path);
  }
  for (const path of indeterminate) rejected.delete(path);

  return { verified, rejected, indeterminate, observed: byCall.size > 0 };
}

/** Absolute-vs-relative tolerant match: equal after normalization, or one is
 *  a `/`-boundary suffix of the other (ledger paths are often absolute while
 *  claims are repo-relative, and occasionally the reverse). */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length > b.length) return a.endsWith(`/${b}`);
  if (b.length > a.length) return b.endsWith(`/${a}`);
  return false;
}

function inSet(claim: string, set: ReadonlySet<string>): boolean {
  for (const path of set) {
    if (pathsMatch(path, claim)) return true;
  }
  return false;
}

/**
 * Cross-check claimed created/modified paths against the write ledger.
 * Indeterminate writers (no recorded terminal status) count as UNVERIFIED
 * with reason `no-write-observed` — absence of a success record is not proof
 * of success — but never as `rejected-write`.
 */
export function verifyClaimedFiles(
  claimedPaths: string[],
  ledger: WriteLedger,
): ClaimedFileVerdict {
  const verdict: ClaimedFileVerdict = {
    verifiedClaims: [],
    unverifiedClaims: [],
    ledgerObserved: ledger.observed,
  };
  if (!ledger.observed) return verdict;
  const seen = new Set<string>();
  for (const raw of claimedPaths) {
    const claim = normalizePath(raw);
    if (!claim || seen.has(claim)) continue;
    seen.add(claim);
    if (inSet(claim, ledger.verified)) {
      verdict.verifiedClaims.push(claim);
    } else if (inSet(claim, ledger.rejected)) {
      verdict.unverifiedClaims.push({ path: claim, reason: "rejected-write" });
    } else {
      verdict.unverifiedClaims.push({
        path: claim,
        reason: "no-write-observed",
      });
    }
  }
  return verdict;
}
