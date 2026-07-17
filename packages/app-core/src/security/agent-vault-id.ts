/**
 * Derives the opaque, per-install vault id that namespaces an agent's secrets in
 * the OS keychain. The id is a deterministic sha256 over the canonical state dir
 * (XDG / `ELIZA_STATE_DIR` precedence, realpath-normalized), base64url-truncated
 * behind a stable `eliza1-` prefix, so one install always resolves the same vault
 * and two state dirs never collide. The state-dir logic is inlined rather than
 * imported from core's heavier composition helpers, and the vault id is paired
 * with a secret kind to form the keychain account handle.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { ElizaError } from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared";
import type { SecureStoreSecretKind } from "./platform-secure-store";

/** Fixed Keychain / Secret Service “service” identifier (see docs/guides/platform-secure-store.md). */
export const ELIZA_AGENT_VAULT_SERVICE = "ai.elizaos.agent.vault";

// Inlined state-dir resolution (rather than core's composition helper) that
// reads via the alias-aware `readAliasedEnv`, so a branded prefix (e.g.
// `ACME_STATE_DIR`) resolves the same vault id from the alias table, with no
// `process.env` mirror involved.
function resolveStateDir(): string {
  const explicit = readAliasedEnv("ELIZA_STATE_DIR");
  if (explicit) return explicit;
  const namespace = readAliasedEnv("ELIZA_NAMESPACE") || "eliza";
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  const stateHome = xdgStateHome
    ? path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(homedir(), xdgStateHome)
    : path.join(homedir(), ".local", "state");
  return path.join(stateHome, namespace);
}

function canonicalizeStateDir(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    // error-policy:J4 A state root may be derived before its directory exists.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw new ElizaError("failed to canonicalize the agent state directory", {
      code: "AGENT_STATE_DIR_CANONICALIZATION_FAILED",
      cause: error,
      severity: "fatal",
    });
  }
}

function vaultTokenForCanonicalStateDir(canonicalStateDir: string): string {
  const hash = createHash("sha256").update(canonicalStateDir, "utf8").digest();
  return Buffer.from(hash).toString("base64url").slice(0, 16);
}

/**
 * Canonical state directory for this process. Mirrors the canonical
 * `ELIZA_STATE_DIR` > XDG state home precedence
 * and uses `realpathSync` when the path exists so symlinks normalize
 * consistently.
 */
export function resolveCanonicalStateDir(): string {
  return canonicalizeStateDir(resolveStateDir());
}

/**
 * Opaque vault id for OS secret stores: `eliza1-` + first 16 chars of base64url(sha256(canonicalStateDir)).
 */
export function deriveAgentVaultId(
  canonicalStateDir = resolveCanonicalStateDir(),
): string {
  const token = vaultTokenForCanonicalStateDir(canonicalStateDir);
  return `eliza1-${token}`;
}

export function keychainAccountForSecretKind(
  vaultId: string,
  kind: SecureStoreSecretKind,
): string {
  return `${vaultId}:${kind}`;
}
