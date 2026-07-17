/**
 * Fingerprinted ownership records for files the orchestrator writes into a
 * sub-agent workspace before or around a run. The residuals gate consumes these
 * records to distinguish unchanged orchestrator scaffolding from worker output:
 * a path name alone never proves ownership, only the bytes the orchestrator
 * wrote and can still verify.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type OrchestratorOwnedArtifactSource =
  | "identity-scaffold"
  | "skills-manifest";

export interface OrchestratorOwnedArtifact {
  path: string;
  sha256: string;
  byteLength: number;
  source: OrchestratorOwnedArtifactSource;
}

export const ORCHESTRATOR_OWNED_ARTIFACTS_METADATA_KEY =
  "orchestratorOwnedArtifacts";

const OWNED_ARTIFACT_SOURCES: ReadonlySet<string> = new Set([
  "identity-scaffold",
  "skills-manifest",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOwnedArtifactSource(
  value: unknown,
): value is OrchestratorOwnedArtifactSource {
  return typeof value === "string" && OWNED_ARTIFACT_SOURCES.has(value);
}

function isOwnedArtifact(value: unknown): value is OrchestratorOwnedArtifact {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.byteLength === "number" &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    isOwnedArtifactSource(value.source)
  );
}

export function readOwnedArtifactsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): OrchestratorOwnedArtifact[] {
  const raw = metadata?.[ORCHESTRATOR_OWNED_ARTIFACTS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isOwnedArtifact);
}

export function toWorkdirRelative(
  workdir: string,
  file: string,
): string | undefined {
  const trimmed = file.trim();
  if (!trimmed) return undefined;
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(workdir, trimmed);
  const rel = relative(workdir, absolute).split("\\").join("/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

function fingerprint(content: string | Buffer): {
  sha256: string;
  byteLength: number;
} {
  const bytes =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

export function createOwnedArtifactRecord(
  workdir: string,
  file: string,
  content: string | Buffer,
  source: OrchestratorOwnedArtifactSource,
): OrchestratorOwnedArtifact | undefined {
  const path = toWorkdirRelative(workdir, file);
  if (!path) return undefined;
  return { path, source, ...fingerprint(content) };
}

export function ownedArtifactStillMatches(
  workdir: string,
  artifact: OrchestratorOwnedArtifact,
): boolean {
  const path = toWorkdirRelative(workdir, artifact.path);
  if (!path || path !== artifact.path) return false;
  try {
    const fullPath = join(workdir, path);
    const stats = lstatSync(fullPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const canonicalWorkdir = realpathSync(workdir);
    const canonicalFile = realpathSync(fullPath);
    const canonicalRelative = relative(canonicalWorkdir, canonicalFile);
    if (
      !canonicalRelative ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      return false;
    }
    const current = readFileSync(fullPath);
    const currentFingerprint = fingerprint(current);
    return (
      currentFingerprint.sha256 === artifact.sha256 &&
      currentFingerprint.byteLength === artifact.byteLength
    );
  } catch {
    // error-policy:J3 an absent/unreadable owned artifact is explicitly not a
    // match, so the residuals gate reports the dirty line instead of fabricating
    // ownership.
    return false;
  }
}
