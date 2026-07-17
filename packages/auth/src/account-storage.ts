/**
 * Per-account credential storage.
 *
 * Layout: `<stateDir>/auth/{providerId}/{accountId}.json` (mode 0600,
 * atomic writes). Multiple accounts per provider are supported.
 *
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger, resolveStateDir } from "@elizaos/core";
import { writeJsonAtomicSync } from "./atomic-json.ts";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  type AccountCredentialProvider,
  type OAuthCredentials,
} from "./types.ts";

let accountAuthGeneration = 0;
const accountAuthGenerationContext = new AsyncLocalStorage<number>();

interface AuthResetTarget {
  root: string;
  target: string;
}

function isPathWithin(root: string, target: string): boolean {
  const fromRoot = path.relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(fromRoot))
  );
}

function trustedPathAnchor(target: string): {
  lexical: string;
  canonical: string;
} {
  const candidates = [os.tmpdir()]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => isPathWithin(candidate, target))
    .sort((left, right) => right.length - left.length);
  const lexical = candidates[0] ?? path.parse(target).root;
  return {
    lexical,
    canonical: fs.realpathSync.native(lexical),
  };
}

function nearestExistingPath(target: string): string {
  let candidate = target;
  while (true) {
    try {
      fs.lstatSync(candidate);
      return candidate;
    } catch (error) {
      // error-policy:J3 Only ENOENT identifies an absent path component;
      // every other filesystem failure makes auth cleanup unprovable.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

function validateAuthPathComponents(target: string): string {
  const resolved = path.resolve(target);
  const anchor = trustedPathAnchor(resolved);
  let current = anchor.lexical;
  for (const component of path
    .relative(anchor.lexical, resolved)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `refusing symlinked account auth reset path: ${current}`,
        );
      }
    } catch (error) {
      // error-policy:J3 Missing future components are safe to validate
      // lexically; any other lstat failure aborts credential deletion.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  const existing = nearestExistingPath(resolved);
  if (isPathWithin(anchor.lexical, existing)) {
    const expected = path.resolve(
      anchor.canonical,
      path.relative(anchor.lexical, existing),
    );
    if (fs.realpathSync.native(existing) !== expected) {
      throw new Error(
        `refusing redirected account auth reset path: ${resolved}`,
      );
    }
  }
  return resolved;
}

function validateAuthResetTarget(root: string, target: string): string {
  const resolvedRoot = validateAuthPathComponents(root);
  const resolvedTarget = validateAuthPathComponents(target);
  if (
    resolvedTarget === resolvedRoot ||
    !isPathWithin(resolvedRoot, resolvedTarget)
  ) {
    throw new Error(
      `refusing account auth reset path outside owned root: ${resolvedTarget}`,
    );
  }
  try {
    const rootCanonical = fs.realpathSync.native(resolvedRoot);
    const existingTarget = nearestExistingPath(resolvedTarget);
    if (
      isPathWithin(resolvedRoot, existingTarget) &&
      !isPathWithin(rootCanonical, fs.realpathSync.native(existingTarget))
    ) {
      throw new Error(
        `refusing redirected account auth reset path: ${resolvedTarget}`,
      );
    }
  } catch (error) {
    // error-policy:J3 A not-yet-created auth root has no canonical target to
    // compare; every other realpath failure aborts reset.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolvedTarget;
}

function resolveAccountAuthResetTargets(
  env: NodeJS.ProcessEnv,
): readonly AuthResetTarget[] {
  const bases = [
    path.resolve(env.ELIZA_HOME || resolveStateDir(env)),
    path.resolve(resolveStateDir(env)),
  ];
  const byTarget = new Map<string, AuthResetTarget>();
  for (const root of bases) {
    const target = path.join(root, "auth");
    byTarget.set(target, { root, target });
  }
  return [...byTarget.values()];
}

function resolveLegacyAccountAuthResetTargets(
  env: NodeJS.ProcessEnv,
): readonly AuthResetTarget[] {
  const root = path.resolve(env.HOME || os.homedir());
  return resolveLegacyAccountAuthArtifacts(env).map((target) => ({
    root,
    target,
  }));
}

/** Runs async account work against the generation active when it starts. */
export function runWithAccountAuthGeneration<T>(operation: () => T): T {
  const inherited = accountAuthGenerationContext.getStore();
  return accountAuthGenerationContext.run(
    inherited ?? accountAuthGeneration,
    operation,
  );
}

/** Rejects a writer whose async operation began before destructive reset. */
export function assertAccountAuthWritesEnabled(): void {
  const operationGeneration = accountAuthGenerationContext.getStore();
  if (
    operationGeneration !== undefined &&
    operationGeneration !== accountAuthGeneration
  ) {
    throw new Error(
      "stale account auth write rejected after destructive reset",
    );
  }
}

export interface AccountCredentialRecord {
  /** accountId, e.g. "default" or a uuid */
  id: string;
  providerId: AccountCredentialProvider;
  /** user-facing name (e.g. "Personal", "Work") */
  label: string;
  source: "oauth" | "api-key";
  /**
   * Existing OAuth credential blob — `{ access, refresh, expires }`
   * for OAuth accounts; for `api-key` accounts only `access` is
   * meaningful (refresh is the empty string and expires is `0` /
   * a distant-expiry sentinel by convention of the caller).
   */
  credentials: OAuthCredentials;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  organizationId?: string;
  userId?: string;
  email?: string;
}

export function resolveAccountAuthRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = path.resolve(env.ELIZA_HOME || resolveStateDir(env));
  if (base === path.parse(base).root) {
    throw new Error("refusing to resolve account auth storage under a root");
  }
  return path.join(base, "auth");
}

export function resolveAccountAuthRoots(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const roots = new Set<string>(
    resolveAccountAuthResetTargets(env).map(({ target }) => target),
  );
  for (const root of roots) {
    const parent = path.dirname(root);
    if (path.basename(root) !== "auth" || parent === path.parse(parent).root) {
      throw new Error(`refusing unsafe account auth reset path: ${root}`);
    }
  }
  return [...roots];
}

/** Legacy Anthropic paths read by older app/plugin releases. */
export function resolveLegacyAccountAuthArtifacts(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const home = path.resolve(env.HOME || os.homedir());
  if (home === path.parse(home).root) {
    throw new Error(
      "refusing to resolve legacy account auth under a root home",
    );
  }
  const authRoot = path.join(home, ".eliza", "auth");
  return [
    path.join(authRoot, "anthropic-subscription"),
    path.join(authRoot, "anthropic-subscription.json"),
  ];
}

/** Validates every owned auth root before reset performs destructive work. */
export function validateAccountAuthResetPaths(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const ownedTargets = resolveAccountAuthResetTargets(env);
  const legacyTargets = resolveLegacyAccountAuthResetTargets(env);
  for (const { root, target } of [...ownedTargets, ...legacyTargets]) {
    validateAuthResetTarget(root, target);
  }
  return ownedTargets.map(({ target }) => target);
}

function providerDir(provider: AccountCredentialProvider): string {
  return path.join(resolveAccountAuthRoot(), provider);
}

/** Removes and verifies the complete account/OAuth materialization store. */
export function deleteAllStoredAccountAuthState(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const roots = validateAccountAuthResetPaths(env);
  const legacyArtifacts = resolveLegacyAccountAuthArtifacts(env);
  // Advance first so async flows that inherited the previous generation fail
  // even if they complete after legitimate post-reset onboarding has begun.
  accountAuthGeneration += 1;
  for (const { root, target } of resolveAccountAuthResetTargets(env)) {
    validateAuthResetTarget(root, target);
    fs.rmSync(target, { force: true, recursive: true });
  }
  for (const { root, target } of resolveLegacyAccountAuthResetTargets(env)) {
    validateAuthResetTarget(root, target);
    fs.rmSync(target, { force: true, recursive: true });
  }
  for (const root of [...roots, ...legacyArtifacts]) {
    if (fs.existsSync(root)) {
      throw new Error(`account auth state survived destructive reset: ${root}`);
    }
  }
}

/** Test-only: restores the generation counter between isolated cases. */
export function __resetAccountAuthWritesForTests(): void {
  accountAuthGeneration = 0;
}

function accountFile(
  provider: AccountCredentialProvider,
  accountId: string,
): string {
  return path.join(providerDir(provider), `${accountId}.json`);
}

function ensureProviderDir(provider: AccountCredentialProvider): void {
  const dir = providerDir(provider);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function isAccountCredentialRecord(
  value: unknown,
): value is AccountCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.providerId === "string" &&
    (ACCOUNT_CREDENTIAL_PROVIDER_IDS as readonly string[]).includes(
      v.providerId,
    ) &&
    typeof v.label === "string" &&
    (v.source === "oauth" || v.source === "api-key") &&
    typeof v.credentials === "object" &&
    v.credentials !== null &&
    typeof (v.credentials as Record<string, unknown>).access === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

export function listAccounts(
  provider: AccountCredentialProvider,
): AccountCredentialRecord[] {
  const dir = providerDir(provider);
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir);
  const records: AccountCredentialRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.endsWith(".tmp.json") || entry.endsWith(".json.tmp")) continue;
    const filePath = path.join(dir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      logger.warn(
        `[auth] Skipping malformed credential file ${filePath}: ${String(err)}`,
      );
      continue;
    }
    if (!isAccountCredentialRecord(parsed)) {
      logger.warn(`[auth] Skipping credential file ${filePath} — wrong shape`);
      continue;
    }
    if (parsed.providerId !== provider) {
      logger.warn(
        `[auth] Credential file ${filePath} declares providerId="${parsed.providerId}", expected "${provider}" — skipping`,
      );
      continue;
    }
    records.push(parsed);
  }

  records.sort((a, b) => a.createdAt - b.createdAt);
  return records;
}

export function loadAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): AccountCredentialRecord | null {
  const file = accountFile(provider, accountId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[auth] Credential file ${file} is malformed JSON: ${String(err)}`,
    );
    return null;
  }
  if (!isAccountCredentialRecord(parsed)) {
    logger.warn(`[auth] Credential file ${file} has wrong shape`);
    return null;
  }
  if (parsed.providerId !== provider || parsed.id !== accountId) {
    logger.warn(
      `[auth] Credential file ${file} provider/id mismatch (got ${parsed.providerId}/${parsed.id})`,
    );
    return null;
  }
  return parsed;
}

export function saveAccount(record: AccountCredentialRecord): void {
  assertAccountAuthWritesEnabled();
  ensureProviderDir(record.providerId);
  const next: AccountCredentialRecord = {
    ...record,
    updatedAt: Date.now(),
  };
  writeJsonAtomicSync(accountFile(record.providerId, record.id), next);
  logger.info(
    `[auth] Saved ${record.providerId} account "${record.id}" (label="${record.label}")`,
  );
}

export function deleteAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): void {
  assertAccountAuthWritesEnabled();
  const file = accountFile(provider, accountId);
  try {
    fs.unlinkSync(file);
    logger.info(`[auth] Deleted ${provider} account "${accountId}"`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export function touchAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): void {
  assertAccountAuthWritesEnabled();
  const existing = loadAccount(provider, accountId);
  if (!existing) return;
  const next: AccountCredentialRecord = {
    ...existing,
    lastUsedAt: Date.now(),
  };
  writeJsonAtomicSync(accountFile(provider, accountId), next);
}
