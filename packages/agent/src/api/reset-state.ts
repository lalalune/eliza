/**
 * Deletes the agent-owned state artifacts covered by the reset contract while
 * retaining downloaded local-model files and unrelated entries. A fixed
 * manifest keeps a custom state-directory override from becoming authority to
 * recursively erase an arbitrary user directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCAL_INFERENCE_DIR = "local-inference";
const LOCAL_MODELS_DIR = "models";
const ROOT_MODELS_DIR = "models";
const ACP_STATE_FILENAMES = [
  "sessions.json",
  "orchestrator-tasks.json",
] as const;
const ACP_AUDIT_FILENAMES = ["audit.ndjson", "audit.ndjson.1"] as const;
const CONNECTOR_AUTH_DIRNAMES = [
  "signal-auth",
  "whatsapp-auth",
  "lifeops-whatsapp-auth",
] as const;

/**
 * Every top-level path currently written below `resolveStateDir()`, excluding
 * the two retained model roots. Add new durable state writers here so reset
 * remains complete without granting it authority over unknown user files.
 */
const OWNED_STATE_ENTRIES: ReadonlySet<string> = new Set([
  ".elizadb",
  ".env",
  ".og",
  ".vault-pglite",
  "agent-runtime.log",
  "agent-vfs",
  "agents",
  "app-registry.json",
  "app-verifications",
  "apps",
  "attachments",
  "audit",
  "auth",
  "backups",
  "binaries",
  "cache",
  "character-backups",
  "clipboard",
  "computer-use-approval.json",
  "config.env",
  "config.env.bak",
  "config.env.bak.tmp",
  "config.env.tmp",
  "core",
  "credential-proxy",
  "credentials",
  "data",
  "database",
  "deleted-conversations.v1.json",
  "desktop-dev-console.log",
  "dev-server-registry.json",
  "device-id",
  "discord-local",
  "eliza-aec-capture.json",
  "eliza.json",
  "exec-approvals.json",
  "exec-approvals.sock",
  "granted-permissions.json",
  "hooks",
  "inference-stats.jsonl",
  "internal",
  "ios-device-deploy-ledger.jsonl",
  "lifeops",
  "logs",
  "matrix-keys",
  "media",
  "optimization",
  "optimized-prompts",
  "orchestrator",
  "permissions.json",
  "plugin-acp",
  "plugins",
  "projects.json",
  "remote-plugins",
  "remote-sessions",
  "runtime-operations",
  "sandbox-workspace",
  "secret-salt",
  "skills",
  "skills.json",
  "sockets",
  "state",
  "steward-credentials.json",
  "sub-agent-sessions",
  "telegram-account",
  "telemetry",
  "test-console",
  "tool-cache",
  "training",
  "trajectories",
  "usage",
  "vast-budget",
  "vault.json",
  "voice-profiles",
  "wallet",
  "workspace",
  "workspace-folder.json",
  "workspaces",
]);

export interface AgentStateResetPathOptions {
  /** True only while this process still owns a runtime using `stateDir`. */
  runtimeOwnsState?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface ResetPathAnchor {
  lexical: string;
  canonical: string;
}

interface ExternalResetTarget {
  root: string;
  target: string;
  recursive: boolean;
  removeEmptyParent?: boolean;
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

function trustedAnchorFor(target: string): ResetPathAnchor {
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
      // error-policy:J3 Only ENOENT means this component is absent; every
      // other filesystem failure makes the reset path unprovable.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

/**
 * Rejects links in every existing component below the platform's canonical
 * temp/home anchor. Realpath comparison also catches link-based redirection
 * when a component disappears between individual lstat probes.
 */
export function validateResetPathComponents(
  target: string,
  label: string,
): string {
  const resolved = path.resolve(target);
  const anchor = trustedAnchorFor(resolved);
  const fromAnchor = path.relative(anchor.lexical, resolved);
  let current = anchor.lexical;
  for (const component of fromAnchor.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`refusing symlinked ${label} reset path: ${current}`);
      }
    } catch (error) {
      // error-policy:J3 Missing future components are safe to validate
      // lexically; any other lstat failure aborts destructive reset.
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
    const canonical = fs.realpathSync.native(existing);
    if (canonical !== expected) {
      throw new Error(`refusing redirected ${label} reset path: ${resolved}`);
    }
  }
  return resolved;
}

/** Validates lexical and canonical containment before deleting an owned leaf. */
export function validateOwnedResetTarget(
  root: string,
  target: string,
  label: string,
): string {
  const resolvedRoot = validateResetPathComponents(root, `${label} root`);
  const resolvedTarget = validateResetPathComponents(target, label);
  if (
    resolvedTarget === resolvedRoot ||
    !isPathWithin(resolvedRoot, resolvedTarget)
  ) {
    throw new Error(
      `refusing ${label} reset path outside owned root: ${resolvedTarget}`,
    );
  }

  try {
    const rootCanonical = fs.realpathSync.native(resolvedRoot);
    const existingTarget = nearestExistingPath(resolvedTarget);
    if (isPathWithin(resolvedRoot, existingTarget)) {
      const targetCanonical = fs.realpathSync.native(existingTarget);
      if (!isPathWithin(rootCanonical, targetCanonical)) {
        throw new Error(
          `refusing redirected ${label} reset path: ${resolvedTarget}`,
        );
      }
    }
  } catch (error) {
    // error-policy:J3 A not-yet-created owned root has no canonical target to
    // compare; all other realpath failures make containment unprovable.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolvedTarget;
}

function validateOwnedSubtree(target: string, label: string): string {
  const resolved = validateResetPathComponents(target, label);
  const parsed = path.parse(resolved);
  if (
    resolved === parsed.root ||
    resolved === path.resolve(os.homedir()) ||
    resolved === path.resolve(os.tmpdir()) ||
    resolved === path.resolve(process.cwd()) ||
    path.dirname(resolved) === parsed.root
  ) {
    throw new Error(`refusing unsafe ${label} reset path: ${resolved}`);
  }
  return resolved;
}

function resolveLegacyHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.HOME?.trim() || os.homedir());
}

function resolveAcpStateRoots(env: NodeJS.ProcessEnv): readonly string[] {
  const defaultRoot = path.join(resolveLegacyHome(env), ".eliza", "plugin-acp");
  const configured = env.ELIZA_ACP_STATE_DIR?.trim();
  return [
    ...new Set(
      [configured ? path.resolve(configured) : undefined, defaultRoot].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
}

function isOwnedAcpEntry(name: string): boolean {
  if ((ACP_AUDIT_FILENAMES as readonly string[]).includes(name)) return true;
  for (const filename of ACP_STATE_FILENAMES) {
    if (name === filename || name === `${filename}.lock`) return true;
    if (name.startsWith(`${filename}.`) && name.endsWith(".tmp")) return true;
  }
  return false;
}

function resolveSubAgentSessionRoots(
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const defaultRoot = path.join(
    resolveLegacyHome(env),
    ".eliza",
    "sub-agent-sessions",
  );
  const configured = env.ELIZA_SUB_AGENT_SESSIONS_DIR?.trim();
  return [
    ...new Set(
      [configured ? path.resolve(configured) : undefined, defaultRoot].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
}

function addAcpResetTargets(
  targets: ExternalResetTarget[],
  env: NodeJS.ProcessEnv,
): void {
  for (const unresolvedRoot of resolveAcpStateRoots(env)) {
    const root = validateOwnedSubtree(unresolvedRoot, "ACP state");
    const names = new Set<string>([
      ...ACP_STATE_FILENAMES,
      ...ACP_STATE_FILENAMES.map((name) => `${name}.lock`),
      ...ACP_AUDIT_FILENAMES,
    ]);
    try {
      for (const name of fs.readdirSync(root)) {
        if (isOwnedAcpEntry(name)) names.add(name);
      }
    } catch (error) {
      // error-policy:J3 A missing optional ACP root is an explicit absent
      // result; unreadable roots abort rather than pretending cleanup passed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names) {
      targets.push({
        root,
        target: validateOwnedResetTarget(
          root,
          path.join(root, name),
          "ACP state",
        ),
        recursive: false,
      });
    }
  }
}

function addSubAgentTranscriptResetTargets(
  targets: ExternalResetTarget[],
  env: NodeJS.ProcessEnv,
): void {
  for (const unresolvedRoot of resolveSubAgentSessionRoots(env)) {
    const root = validateOwnedSubtree(
      unresolvedRoot,
      "sub-agent transcript state",
    );
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      // error-policy:J3 A missing transcript root is explicitly absent;
      // unreadable roots must fail reset so transcripts cannot be hidden.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sessionDir = path.join(root, entry.name);
      const transcript = path.join(sessionDir, "transcript.log");
      if (!fs.existsSync(transcript)) continue;
      validateOwnedResetTarget(root, sessionDir, "sub-agent session");
      targets.push({
        root,
        target: validateOwnedResetTarget(
          root,
          transcript,
          "sub-agent transcript",
        ),
        recursive: false,
        removeEmptyParent: true,
      });
    }
  }
}

function assertConnectorAuthOverrideIsOwned(
  envKey: string,
  rawPath: string | undefined,
  ownedRoot: string,
): void {
  const configured = rawPath?.trim();
  if (!configured) return;
  const resolved = path.resolve(configured);
  if (!isPathWithin(ownedRoot, resolved)) {
    throw new Error(
      `agent reset cannot erase unsupported ${envKey} outside its owned workspace directory: ${resolved}`,
    );
  }
  if (resolved === ownedRoot) {
    validateResetPathComponents(resolved, `${envKey} credential`);
  } else {
    validateOwnedResetTarget(ownedRoot, resolved, `${envKey} credential`);
  }
}

function addWorkspaceCredentialResetTargets(
  targets: ExternalResetTarget[],
  workspaceDir: string | undefined,
  env: NodeJS.ProcessEnv,
): void {
  if (!workspaceDir?.trim()) return;
  const workspaceRoot = validateResetPathComponents(
    workspaceDir,
    "agent workspace",
  );
  const ownedRoots = new Map<string, string>(
    CONNECTOR_AUTH_DIRNAMES.map(
      (name) =>
        [
          name,
          validateOwnedResetTarget(
            workspaceRoot,
            path.join(workspaceRoot, name),
            `${name} credential state`,
          ),
        ] as const,
    ),
  );
  const signalRoot = ownedRoots.get("signal-auth");
  const whatsappRoot = ownedRoots.get("whatsapp-auth");
  if (!signalRoot || !whatsappRoot) {
    throw new Error("connector credential reset manifest is incomplete");
  }
  assertConnectorAuthOverrideIsOwned(
    "SIGNAL_AUTH_DIR",
    env.SIGNAL_AUTH_DIR,
    signalRoot,
  );
  assertConnectorAuthOverrideIsOwned(
    "WHATSAPP_AUTH_DIR",
    env.WHATSAPP_AUTH_DIR,
    whatsappRoot,
  );
  assertConnectorAuthOverrideIsOwned(
    "WHATSAPP_SESSION_PATH",
    env.WHATSAPP_SESSION_PATH,
    whatsappRoot,
  );
  for (const [name, target] of ownedRoots) {
    targets.push({
      root: workspaceRoot,
      target,
      recursive: true,
    });
    validateOwnedResetTarget(workspaceRoot, target, `${name} credential state`);
  }
}

function buildExternalResetTargets(
  stateDir: string,
  env: NodeJS.ProcessEnv,
  workspaceDir?: string,
): readonly ExternalResetTarget[] {
  const targets: ExternalResetTarget[] = [];
  const explicitOAuthRoot = env.ELIZA_OAUTH_DIR?.trim();
  if (explicitOAuthRoot) {
    const oauthRoot = validateOwnedSubtree(explicitOAuthRoot, "OAuth state");
    const defaultCredentialRoot = path.join(
      path.resolve(stateDir),
      "credentials",
    );
    if (oauthRoot !== defaultCredentialRoot) {
      for (const leaf of ["health", "payments"] as const) {
        targets.push({
          root: oauthRoot,
          target: validateOwnedResetTarget(
            oauthRoot,
            path.join(oauthRoot, "lifeops", leaf),
            "OAuth state",
          ),
          recursive: true,
          removeEmptyParent: true,
        });
      }
    }
  }
  addAcpResetTargets(targets, env);
  addSubAgentTranscriptResetTargets(targets, env);
  addWorkspaceCredentialResetTargets(targets, workspaceDir, env);
  return targets;
}

/** Validates every fixed reset leaf persisted outside the canonical state root. */
export function validateExternalAgentStateResetPaths(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  workspaceDir?: string,
): readonly string[] {
  return buildExternalResetTargets(stateDir, env, workspaceDir).map(
    ({ target }) => target,
  );
}

/** Deletes fixed external leaves without granting authority over broad overrides. */
export function deleteExternalAgentStateForReset(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  workspaceDir?: string,
): void {
  const targets = buildExternalResetTargets(stateDir, env, workspaceDir);
  for (const descriptor of targets) {
    const target = validateOwnedResetTarget(
      descriptor.root,
      descriptor.target,
      "external agent state",
    );
    fs.rmSync(target, {
      force: true,
      recursive: descriptor.recursive,
    });
    if (fs.existsSync(target)) {
      throw new Error(`external agent state survived reset: ${target}`);
    }
    if (descriptor.removeEmptyParent) {
      const parent = path.dirname(target);
      validateOwnedResetTarget(
        descriptor.root,
        parent,
        "external state parent",
      );
      try {
        fs.rmdirSync(parent);
      } catch (error) {
        // error-policy:J4 The override may contain unrelated files; preserve
        // any non-empty parent after its fixed owned leaf is gone.
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        ) {
          throw error;
        }
      }
    }
  }
}

function isOwnedStateEntry(name: string, env: NodeJS.ProcessEnv): boolean {
  if (OWNED_STATE_ENTRIES.has(name)) return true;
  if (name.startsWith(".vault-pglite.corrupt-")) return true;
  const namespace = env.ELIZA_NAMESPACE?.trim() || "eliza";
  return name === `${namespace}.json`;
}

/** Validates the configured root before a reset performs any destructive step. */
export function validateAgentStateResetPath(
  stateDir: string,
  options: AgentStateResetPathOptions = {},
): string {
  const resolved = validateResetPathComponents(stateDir, "agent state root");
  const parsed = path.parse(resolved);
  const forbidden = new Set([
    parsed.root,
    path.resolve(os.homedir()),
    path.resolve(os.tmpdir()),
    path.resolve(process.cwd()),
  ]);
  if (forbidden.has(resolved) || path.dirname(resolved) === parsed.root) {
    throw new Error(`refusing unsafe agent state reset path: ${resolved}`);
  }
  const env = options.env ?? process.env;
  const explicitRoot = env.ELIZA_STATE_DIR?.trim();
  if (
    explicitRoot &&
    path.resolve(explicitRoot) === resolved &&
    !options.runtimeOwnsState &&
    !fs.existsSync(path.join(resolved, ".eliza-state-root"))
  ) {
    throw new Error(
      `refusing unproven custom agent state reset path: ${resolved}`,
    );
  }
  return resolved;
}

/** Persists proof that this runtime successfully initialized the custom root. */
export function writeAgentStateOwnershipMarker(
  stateDir: string,
  options: AgentStateResetPathOptions,
): void {
  if (!options.runtimeOwnsState) {
    throw new Error(
      "refusing to mark a state root without live runtime ownership",
    );
  }
  const root = validateAgentStateResetPath(stateDir, options);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = path.join(root, ".eliza-state-root");
  fs.writeFileSync(marker, "elizaOS agent state\n", { mode: 0o600 });
}

function removeEntry(root: string, target: string): void {
  validateOwnedResetTarget(root, target, "agent state");
  fs.rmSync(target, { force: true, recursive: true });
  if (fs.existsSync(target)) {
    throw new Error(`agent state survived destructive reset: ${target}`);
  }
}

/** Removes all known owned state while retaining both downloaded-model roots. */
export function deleteAgentStateForReset(
  stateDir: string,
  options: AgentStateResetPathOptions = {},
): void {
  const root = validateAgentStateResetPath(stateDir, options);
  if (!fs.existsSync(root)) return;
  validateResetPathComponents(root, "agent state root");
  const env = options.env ?? process.env;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.name === ROOT_MODELS_DIR) continue;
    if (entry.name === LOCAL_INFERENCE_DIR) {
      if (!entry.isDirectory()) {
        removeEntry(root, target);
        continue;
      }
      validateOwnedResetTarget(root, target, "local inference state");
      for (const localEntry of fs.readdirSync(target)) {
        if (localEntry === LOCAL_MODELS_DIR) continue;
        removeEntry(root, path.join(target, localEntry));
      }
      continue;
    }
    if (isOwnedStateEntry(entry.name, env)) removeEntry(root, target);
  }

  for (const entry of fs.readdirSync(root)) {
    if (
      entry !== ROOT_MODELS_DIR &&
      entry !== LOCAL_INFERENCE_DIR &&
      isOwnedStateEntry(entry, env)
    ) {
      throw new Error(
        `agent state reset verification failed: ${path.join(root, entry)}`,
      );
    }
  }
  const localInferencePath = path.join(root, LOCAL_INFERENCE_DIR);
  if (
    fs.existsSync(localInferencePath) &&
    fs.readdirSync(localInferencePath).some((name) => name !== LOCAL_MODELS_DIR)
  ) {
    throw new Error(
      `agent state reset verification failed: ${localInferencePath}`,
    );
  }
}
