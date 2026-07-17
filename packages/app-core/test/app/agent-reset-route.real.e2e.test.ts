/**
 * Drives destructive agent reset through a real loopback server and PGLite runtime.
 * Every mutable home, config, state, database, vault, and OAuth path is rooted in one temporary tree before runtime modules load.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function loadResetHarnessModules() {
  const [
    cloudSecrets,
    serverApi,
    vaultApi,
    accountStorage,
    agentVaultId,
    llmProxy,
    httpHelpers,
    realRuntime,
  ] = await Promise.all([
    import("@elizaos/shared/elizacloud/cloud-secrets"),
    import("../../src/api/server.ts"),
    import("@elizaos/vault"),
    import("@elizaos/auth/account-storage"),
    import("../../src/security/agent-vault-id.ts"),
    import("../../../test/mocks/helpers/llm-proxy-plugin.ts"),
    import("../helpers/http.ts"),
    import("../helpers/real-runtime.ts"),
  ]);

  return {
    resetCloudSecretsForTesting: cloudSecrets._resetCloudSecretsForTesting,
    getCloudSecret: cloudSecrets.getCloudSecret,
    scrubCloudSecretsFromEnv: cloudSecrets.scrubCloudSecretsFromEnv,
    getSharedCompatRuntimeState: serverApi.getSharedCompatRuntimeState,
    startApiServer: serverApi.startApiServer,
    resolveDefaultVaultDataDir: vaultApi.resolveDefaultVaultDataDir,
    resetAccountAuthWritesForTests:
      accountStorage.__resetAccountAuthWritesForTests,
    loadAccount: accountStorage.loadAccount,
    resolveAccountAuthRoots: accountStorage.resolveAccountAuthRoots,
    resolveLegacyAccountAuthArtifacts:
      accountStorage.resolveLegacyAccountAuthArtifacts,
    saveAccount: accountStorage.saveAccount,
    deriveAgentVaultId: agentVaultId.deriveAgentVaultId,
    resolveCanonicalStateDir: agentVaultId.resolveCanonicalStateDir,
    createDeterministicLlmProxyPlugin:
      llmProxy.createDeterministicLlmProxyPlugin,
    req: httpHelpers.req,
    createRealTestRuntime: realRuntime.createRealTestRuntime,
  };
}

type ResetHarnessModules = Awaited<ReturnType<typeof loadResetHarnessModules>>;
type RuntimeResult = Awaited<
  ReturnType<ResetHarnessModules["createRealTestRuntime"]>
>;
type TestServer = Awaited<ReturnType<ResetHarnessModules["startApiServer"]>>;

function writeFixture(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

function writeJsonFixture(
  filePath: string,
  value: Record<string, unknown>,
): void {
  writeFixture(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, snapshot);
}

function syncBunEnv(): void {
  const bun = (
    globalThis as typeof globalThis & {
      Bun?: { env?: Record<string, string | undefined> };
    }
  ).Bun;
  if (bun) bun.env = { ...process.env };
}

function expectPathWithin(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  expect(relative).not.toBe("");
  expect(relative).not.toBe("..");
  expect(relative.startsWith(`..${path.sep}`)).toBe(false);
  expect(path.isAbsolute(relative)).toBe(false);
}

function expectJsonFileToEqual(
  filePath: string,
  expected: Record<string, unknown>,
): void {
  expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(expected);
}

describe("POST /api/agent/reset (real HTTP handler)", () => {
  let envSnapshot: NodeJS.ProcessEnv = {};
  let dataRoot = "";
  let homeDir = "";
  let elizaHome = "";
  let stateDir = "";
  let baseConfigPath = "";
  let overlayConfigPath = "";
  let pgliteDir = "";
  let oauthRoot = "";
  let modules: ResetHarnessModules | null = null;
  let runtimeResult: RuntimeResult | null = null;
  let server: TestServer | null = null;

  beforeEach(async () => {
    envSnapshot = { ...process.env };
    dataRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-reset-route-")),
    );
    homeDir = path.join(dataRoot, "home");
    elizaHome = path.join(dataRoot, "eliza-home");
    stateDir = path.join(dataRoot, "state");
    baseConfigPath = path.join(dataRoot, "config", "base.json");
    overlayConfigPath = path.join(dataRoot, "config", "overlay.json");
    pgliteDir = path.join(stateDir, ".elizadb");
    oauthRoot = path.join(dataRoot, "external-oauth");

    const tempDir = path.join(dataRoot, "tmp");
    const hostsPath = path.join(dataRoot, "system", "hosts");
    for (const directory of [
      homeDir,
      elizaHome,
      stateDir,
      tempDir,
      path.dirname(baseConfigPath),
      oauthRoot,
    ]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeFixture(hostsPath, "127.0.0.1 localhost\n");

    Object.assign(process.env, {
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELIZA_HOME: elizaHome,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_CONFIG_PATH: baseConfigPath,
      ELIZA_PERSIST_CONFIG_PATH: overlayConfigPath,
      PGLITE_DATA_DIR: pgliteDir,
      ELIZA_OAUTH_DIR: oauthRoot,
      XDG_CONFIG_HOME: path.join(dataRoot, "xdg-config"),
      XDG_STATE_HOME: path.join(dataRoot, "xdg-state"),
      CODEX_HOME: path.join(dataRoot, "codex-home"),
      CLAUDE_CONFIG_DIR: path.join(dataRoot, "claude-home"),
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
      WEBSITE_BLOCKER_HOSTS_FILE_PATH: hostsPath,
      SELFCONTROL_HOSTS_FILE_PATH: hostsPath,
      ELIZA_NAMESPACE: "eliza-reset-e2e",
      ELIZA_PLATFORM: "android",
      ELIZA_WALLET_OS_STORE: "0",
      ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
      ELIZA_VAULT_PASSPHRASE: "reset-e2e-passphrase",
      ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP: "1",
    });
    for (const key of [
      "ELIZA_REQUIRE_LOCAL_AUTH",
      "ELIZA_ACP_STATE_DIR",
      "ELIZA_SUB_AGENT_SESSIONS_DIR",
      "ELIZA_WORKSPACE_DIR",
      "SIGNAL_AUTH_DIR",
      "WHATSAPP_AUTH_DIR",
      "WHATSAPP_SESSION_PATH",
      "ELIZA_CLOUD_PROVISIONED",
      "ELIZA_API_TOKEN",
      "DATABASE_URL",
      "POSTGRES_URL",
      "ELIZA_PGLITE_DATA_DIR_IN_USE",
      "EVM_PRIVATE_KEY",
      "SOLANA_PRIVATE_KEY",
      "STEWARD_API_URL",
      "STEWARD_TENANT_ID",
      "STEWARD_AGENT_ID",
      "STEWARD_API_KEY",
      "STEWARD_AGENT_TOKEN",
      "ELIZA_STEWARD_AGENT_ID",
      "STEWARD_EVM_ADDRESS",
      "STEWARD_SOLANA_ADDRESS",
      "SOLANA_PUBLIC_KEY",
      "WALLET_PUBLIC_KEY",
      "RESET_E2E_BASE_SECRET",
      "RESET_E2E_OVERLAY_SECRET",
      "RESET_E2E_FILE_SECRET",
      "DISCORD_LOCAL_CLIENT_SECRET",
      "ELIZAOS_CLOUD_API_KEY",
    ]) {
      delete process.env[key];
    }
    syncBunEnv();

    writeJsonFixture(baseConfigPath, {
      meta: { firstRunComplete: true, source: "base" },
      agents: { list: [{ id: "reset-agent", name: "Reset Route Agent" }] },
      env: { RESET_E2E_BASE_SECRET: "base-secret" },
      plugins: {
        entries: {
          "plugin-reset-e2e": {
            config: { API_KEY: "base-plugin-credential" },
          },
        },
      },
    });
    writeJsonFixture(overlayConfigPath, {
      meta: { source: "overlay" },
      env: { vars: { RESET_E2E_OVERLAY_SECRET: "overlay-secret" } },
      connectors: {
        discordLocal: { clientSecret: "overlay-connector-secret" },
      },
    });
    writeFixture(`${baseConfigPath}.tmp.stale`, "base-staging-secret\n");
    writeFixture(`${overlayConfigPath}.tmp.stale`, "overlay-staging-secret\n");

    modules = await loadResetHarnessModules();
    modules.resetCloudSecretsForTesting();
    modules.resetAccountAuthWritesForTests();

    const canonicalStateDir = modules.resolveCanonicalStateDir();
    expect(canonicalStateDir).toBe(fs.realpathSync(stateDir));
    expect(modules.deriveAgentVaultId()).toBe(
      modules.deriveAgentVaultId(canonicalStateDir),
    );
    for (const destructivePath of [
      canonicalStateDir,
      pgliteDir,
      modules.resolveDefaultVaultDataDir(),
      baseConfigPath,
      overlayConfigPath,
      ...modules.resolveAccountAuthRoots(),
      ...modules.resolveLegacyAccountAuthArtifacts(),
      path.join(oauthRoot, "lifeops"),
    ]) {
      expectPathWithin(dataRoot, destructivePath);
    }

    runtimeResult = await modules.createRealTestRuntime({
      characterName: "AgentResetRouteLive",
      plugins: [
        modules.createDeterministicLlmProxyPlugin({
          failOnUnhandledAction: false,
        }),
      ],
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    server = await modules.startApiServer({
      port: 0,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
  }, 120_000);

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    if (server && modules) {
      try {
        const cleanupReset = await modules.req(
          server.port,
          "POST",
          "/api/agent/reset",
          {},
          undefined,
          { timeoutMs: 90_000 },
        );
        if (cleanupReset.status !== 200) {
          cleanupErrors.push(
            new Error(`cleanup reset returned ${cleanupReset.status}`),
          );
        } else {
          runtimeResult = null;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (server) await attempt(() => server?.close() ?? Promise.resolve());
    if (runtimeResult)
      await attempt(() => runtimeResult?.cleanup() ?? Promise.resolve());
    modules?.resetAccountAuthWritesForTests();
    modules?.resetCloudSecretsForTesting();
    if (dataRoot) {
      await attempt(() => fsp.rm(dataRoot, { recursive: true, force: true }));
    }
    restoreProcessEnv(envSnapshot);
    syncBunEnv();

    modules = null;
    runtimeResult = null;
    server = null;

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "agent reset E2E cleanup failed");
    }
  });

  it("erases every owned source, preserves models and unrelated files, and can reset and onboard again in-process", async () => {
    if (!modules || !server) throw new Error("reset harness did not start");
    const port = server.port;

    const rootModel = path.join(stateDir, "models", "root-model.gguf");
    const localModel = path.join(
      stateDir,
      "local-inference",
      "models",
      "local-model.gguf",
    );
    const stateSentinel = path.join(stateDir, "user-owned-reset-sentinel.txt");
    const homeSentinel = path.join(homeDir, "user-owned-home-sentinel.txt");
    const externalOAuthSentinel = path.join(
      oauthRoot,
      "other-app",
      "token.json",
    );
    for (const [filePath, contents] of [
      [rootModel, "root-model-bytes"],
      [localModel, "local-model-bytes"],
      [stateSentinel, "keep-state"],
      [homeSentinel, "keep-home"],
      [externalOAuthSentinel, "keep-external-oauth"],
      [path.join(stateDir, ".eliza-state-root"), "owned\n"],
      [
        path.join(stateDir, "plugins", "plugin-reset", "credential.json"),
        "plugin-secret",
      ],
      [
        path.join(stateDir, "credentials", "connector", "token.json"),
        "connector-secret",
      ],
      [path.join(stateDir, "media", "private.bin"), "private-media"],
      [path.join(stateDir, "hooks", "installed", "hook.json"), "hook-secret"],
      [path.join(stateDir, "exec-approvals.json"), "approval-secret"],
      [path.join(stateDir, "permissions.json"), "permission-secret"],
      [
        path.join(stateDir, "local-inference", "registry.json"),
        "registry-secret",
      ],
      [
        path.join(oauthRoot, "lifeops", "health", "token.json"),
        "lifeops-oauth-secret",
      ],
    ] as const) {
      writeFixture(filePath, contents);
    }

    const configEnvArtifacts = [
      path.join(stateDir, "config.env"),
      path.join(stateDir, "config.env.bak"),
      path.join(stateDir, "config.env.tmp"),
      path.join(stateDir, "config.env.bak.tmp"),
    ];
    writeFixture(configEnvArtifacts[0], "RESET_E2E_FILE_SECRET=live-secret\n");
    writeFixture(
      configEnvArtifacts[1],
      "RESET_E2E_FILE_SECRET=backup-secret\n",
    );
    writeFixture(
      configEnvArtifacts[2],
      "RESET_E2E_FILE_SECRET=staging-secret\n",
    );
    writeFixture(
      configEnvArtifacts[3],
      "RESET_E2E_FILE_SECRET=backup-staging-secret\n",
    );

    const accountRecord = {
      id: "before-reset",
      providerId: "openai-api" as const,
      label: "Before reset",
      source: "api-key" as const,
      credentials: { access: "account-secret", refresh: "", expires: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    modules.saveAccount(accountRecord);
    const authRoots = modules.resolveAccountAuthRoots();
    for (const authRoot of authRoots) {
      writeFixture(path.join(authRoot, "_pool-metadata.json"), "pool-secret");
      writeFixture(
        path.join(authRoot, "_codex-home", "before-reset", "auth.json"),
        "materialized-secret",
      );
    }
    const legacyAuthArtifacts = modules.resolveLegacyAccountAuthArtifacts();
    for (const artifact of legacyAuthArtifacts) {
      if (path.extname(artifact)) {
        writeFixture(artifact, "legacy-auth-secret");
      } else {
        writeFixture(path.join(artifact, "default.json"), "legacy-auth-secret");
      }
    }

    const seededVaultWrite = await modules.req(
      port,
      "PUT",
      "/api/secrets/inventory/plugin.reset.api-key",
      { value: "vault-secret", label: "Reset E2E secret" },
    );
    expect(seededVaultWrite.status).toBe(200);
    expect(seededVaultWrite.data.ok).toBe(true);
    const seededVaultRead = await modules.req(
      port,
      "GET",
      "/api/secrets/inventory/plugin.reset.api-key",
    );
    expect(seededVaultRead.status).toBe(200);
    expect(seededVaultRead.data.value).toBe("vault-secret");
    expect(fs.existsSync(modules.resolveDefaultVaultDataDir())).toBe(true);

    process.env.ELIZAOS_CLOUD_API_KEY = "sealed-cloud-secret";
    modules.scrubCloudSecretsFromEnv();
    expect(modules.getCloudSecret("ELIZAOS_CLOUD_API_KEY")).toBe(
      "sealed-cloud-secret",
    );

    const beforeStatus = await modules.req(
      port,
      "GET",
      "/api/first-run/status",
    );
    expect(beforeStatus.status).toBe(200);
    expect(beforeStatus.data.complete).toBe(true);
    expect(process.env.RESET_E2E_BASE_SECRET).toBe("base-secret");
    expect(process.env.RESET_E2E_OVERLAY_SECRET).toBe("overlay-secret");
    expect(process.env.RESET_E2E_FILE_SECRET).toBe("live-secret");
    expect(process.env.DISCORD_LOCAL_CLIENT_SECRET).toBe(
      "overlay-connector-secret",
    );
    expect(modules.getSharedCompatRuntimeState().current).not.toBeNull();
    expect(fs.existsSync(pgliteDir)).toBe(true);

    const reset = await modules.req(
      port,
      "POST",
      "/api/agent/reset",
      {},
      undefined,
      {
        timeoutMs: 90_000,
      },
    );
    if (reset.status === 200) runtimeResult = null;
    expect(reset.status).toBe(200);
    expect(reset.data).toEqual({ ok: true });
    expect(modules.getSharedCompatRuntimeState().current).toBeNull();

    expectJsonFileToEqual(baseConfigPath, {});
    expectJsonFileToEqual(overlayConfigPath, {});
    for (const artifact of [
      `${baseConfigPath}.tmp.stale`,
      `${overlayConfigPath}.tmp.stale`,
      ...configEnvArtifacts,
      pgliteDir,
      modules.resolveDefaultVaultDataDir(),
      path.join(stateDir, "plugins"),
      path.join(stateDir, "credentials"),
      path.join(stateDir, "media"),
      path.join(stateDir, "hooks"),
      path.join(stateDir, "exec-approvals.json"),
      path.join(stateDir, "permissions.json"),
      path.join(stateDir, "local-inference", "registry.json"),
      path.join(oauthRoot, "lifeops"),
      ...authRoots,
      ...legacyAuthArtifacts,
    ]) {
      expect(fs.existsSync(artifact), artifact).toBe(false);
    }
    for (const key of [
      "RESET_E2E_BASE_SECRET",
      "RESET_E2E_OVERLAY_SECRET",
      "RESET_E2E_FILE_SECRET",
      "DISCORD_LOCAL_CLIENT_SECRET",
      "ELIZAOS_CLOUD_API_KEY",
    ]) {
      expect(process.env[key]).toBeUndefined();
    }
    expect(modules.getCloudSecret("ELIZAOS_CLOUD_API_KEY")).toBeUndefined();

    expect(fs.readFileSync(rootModel, "utf8")).toBe("root-model-bytes");
    expect(fs.readFileSync(localModel, "utf8")).toBe("local-model-bytes");
    expect(fs.readFileSync(stateSentinel, "utf8")).toBe("keep-state");
    expect(fs.readFileSync(homeSentinel, "utf8")).toBe("keep-home");
    expect(fs.readFileSync(externalOAuthSentinel, "utf8")).toBe(
      "keep-external-oauth",
    );

    const afterStatus = await modules.req(port, "GET", "/api/first-run/status");
    expect(afterStatus.status).toBe(200);
    expect(afterStatus.data.complete).toBe(false);

    const idempotentReset = await modules.req(
      port,
      "POST",
      "/api/agent/reset",
      {},
      undefined,
      { timeoutMs: 90_000 },
    );
    expect(idempotentReset.status).toBe(200);
    expect(idempotentReset.data).toEqual({ ok: true });
    expectJsonFileToEqual(baseConfigPath, {});
    expectJsonFileToEqual(overlayConfigPath, {});
    expect(fs.readFileSync(rootModel, "utf8")).toBe("root-model-bytes");
    expect(fs.readFileSync(localModel, "utf8")).toBe("local-model-bytes");
    expect(fs.readFileSync(stateSentinel, "utf8")).toBe("keep-state");

    modules.saveAccount({
      ...accountRecord,
      id: "after-reset",
      label: "After reset",
      credentials: { access: "new-account-secret", refresh: "", expires: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(
      modules.loadAccount("openai-api", "after-reset")?.credentials.access,
    ).toBe("new-account-secret");

    const afterResetVaultWrite = await modules.req(
      port,
      "PUT",
      "/api/secrets/inventory/plugin.reset.api-key",
      { value: "new-vault-secret", label: "New reset E2E secret" },
    );
    expect(afterResetVaultWrite.status).toBe(200);
    expect(afterResetVaultWrite.data.ok).toBe(true);
    const afterResetVaultRead = await modules.req(
      port,
      "GET",
      "/api/secrets/inventory/plugin.reset.api-key",
    );
    expect(afterResetVaultRead.status).toBe(200);
    expect(afterResetVaultRead.data.value).toBe("new-vault-secret");

    const rewrittenStateReset = await modules.req(
      port,
      "POST",
      "/api/agent/reset",
      {},
      undefined,
      { timeoutMs: 90_000 },
    );
    expect(rewrittenStateReset.status).toBe(200);
    expect(rewrittenStateReset.data).toEqual({ ok: true });
    expect(modules.loadAccount("openai-api", "after-reset")).toBeNull();
    expect(fs.existsSync(modules.resolveDefaultVaultDataDir())).toBe(false);
  }, 120_000);
});
