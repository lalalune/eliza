/**
 * Mounts the destructive agent-admin HTTP routes on the shared route state:
 * POST /api/agent/restart re-initializes the runtime through the injected restart
 * handler and refreshes the reported status, and POST /api/agent/reset stops the
 * runtime, deletes the PGlite data directory (guarded to only ever remove a path
 * whose basename is `.elizadb`), clears the persisted first-run config, and wipes
 * the cloud vault entries so the next boot does not rehydrate a signed-in Eliza
 * Cloud state. Sits behind the authenticated dashboard gate; not public.
 */
import fs from "node:fs";
import path from "node:path";
import {
  deleteAllStoredAccountAuthState,
  validateAccountAuthResetPaths,
} from "@elizaos/auth/account-storage";
import { resetCredentialRefreshStateForAgentReset } from "@elizaos/auth/credentials";
import { cancelAllOAuthFlowsForReset } from "@elizaos/auth/oauth-flow";
import {
  type AgentRuntime,
  type RouteRequestMeta,
  resetConnectorAccountStateForDestructiveReset,
  type UUID,
} from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import {
  getDefaultStylePreset,
  normalizeCharacterLanguage,
} from "@elizaos/shared";
import { clearCloudSecrets } from "@elizaos/shared/elizacloud/cloud-secrets";
import { loadElizaConfig, saveElizaConfigForReset } from "../config/config.ts";
import {
  resolveStewardCredentialsPath,
  resolveUserPath,
} from "../config/paths.ts";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import type { AutonomousConfigLike } from "../types/config-like.ts";
import { detectRuntimeModel } from "./agent-model.ts";
import {
  deleteConfigEnvForReset,
  validateConfigEnvResetPaths,
} from "./config-env.ts";
import { clearPersistedFirstRunConfig } from "./provider-switch-config.ts";
import {
  deleteAgentStateForReset,
  deleteExternalAgentStateForReset,
  validateAgentStateResetPath,
  validateExternalAgentStateResetPaths,
  validateOwnedResetTarget,
  validateResetPathComponents,
  writeAgentStateOwnershipMarker,
} from "./reset-state.ts";
import { resetSubscriptionOAuthStateForAgentReset } from "./subscription-routes.ts";
import { resetStewardWalletCache } from "./wallet.ts";

type AgentStateStatus =
  | "not_started"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "restarting"
  | "error";

function resolveDefaultAgentName(config: AutonomousConfigLike): string {
  const ui = config.ui as
    | { assistant?: { name?: string }; language?: string }
    | undefined;
  const agents = config.agents as
    | { list?: Array<{ name?: string }> }
    | undefined;
  const configuredName =
    ui?.assistant?.name?.trim() ?? agents?.list?.[0]?.name?.trim();
  if (configuredName) {
    return configuredName;
  }

  return getDefaultStylePreset(normalizeCharacterLanguage(ui?.language)).name;
}

export interface AgentAdminRouteState {
  runtime: AgentRuntime | null;
  config: AutonomousConfigLike;
  agentState: AgentStateStatus;
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: { userId: UUID; roomId: UUID; worldId: UUID } | null;
  chatConnectionPromise: Promise<void> | null;
  pendingRestartReasons: string[];
  conversations?: Map<string, unknown>;
  activeConversationId?: string | null;
  conversationRestorePromise?: Promise<void> | null;
}

export interface AgentAdminRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  state: AgentAdminRouteState;
  onRestart?: (() => Promise<AgentRuntime | null>) | undefined;
  onRuntimeSwapped?: () => void;
  resolveStateDir: () => string;
  stateDirExists: (resolvedState: string) => boolean;
  removeStateDir: (resolvedState: string) => void;
  resetRuntimeOperationStateForAgentReset?: () => void;
  logWarn: (message: string) => void;
}

function resolveResetPgliteDataDir(
  config: ReturnType<typeof loadElizaConfig>,
  stateDir: string,
): string {
  const explicitDataDir = process.env.PGLITE_DATA_DIR?.trim();
  if (explicitDataDir) {
    return resolveUserPath(explicitDataDir);
  }

  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  if (configuredDataDir) {
    return resolveUserPath(configuredDataDir);
  }

  const workspaceDir =
    config.agents?.defaults?.workspace ?? `${stateDir}/workspace`;
  return path.join(resolveUserPath(workspaceDir), ".elizadb");
}

function validateResetPgliteDataDir(
  config: ReturnType<typeof loadElizaConfig>,
  stateDir: string,
): string {
  if (
    config.database?.provider === "postgres" ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim()
  ) {
    throw new Error(
      "agent reset cannot erase an external Postgres database; remove its agent data explicitly before resetting",
    );
  }
  const dataDir = validateResetPathComponents(
    resolveResetPgliteDataDir(config, stateDir),
    "PGlite data",
  );
  if (path.basename(dataDir) !== ".elizadb") {
    throw new Error(
      `[eliza-api] Refusing to delete unexpected PGlite dir during reset: "${dataDir}"`,
    );
  }
  const resolvedStateDir = validateResetPathComponents(
    stateDir,
    "agent state root",
  );
  const configuredWorkspace = validateResetPathComponents(
    resolveUserPath(
      config.agents?.defaults?.workspace ?? `${stateDir}/workspace`,
    ),
    "agent workspace",
  );
  const configuredPgliteDataDir = config.database?.pglite?.dataDir?.trim();
  const expectedConfiguredDataDir = configuredPgliteDataDir
    ? path.resolve(resolveUserPath(configuredPgliteDataDir))
    : null;
  if (
    dataDir !== expectedConfiguredDataDir &&
    dataDir !== path.join(configuredWorkspace, ".elizadb") &&
    dataDir !== path.join(resolvedStateDir, ".elizadb") &&
    !dataDir.startsWith(`${resolvedStateDir}${path.sep}`)
  ) {
    throw new Error(
      `[eliza-api] Refusing unowned PGlite dir during reset: "${dataDir}"`,
    );
  }
  const ownedRoot = dataDir.startsWith(`${resolvedStateDir}${path.sep}`)
    ? resolvedStateDir
    : dataDir === path.join(configuredWorkspace, ".elizadb")
      ? configuredWorkspace
      : path.dirname(dataDir);
  validateOwnedResetTarget(ownedRoot, dataDir, "PGlite data");
  return dataDir;
}

export const __agentAdminResetPathTesting = {
  validateResetPgliteDataDir,
};

export async function handleAgentAdminRoutes(
  ctx: AgentAdminRouteContext,
): Promise<boolean> {
  const {
    res,
    method,
    pathname,
    state,
    onRestart,
    onRuntimeSwapped,
    json,
    error,
    resolveStateDir,
    stateDirExists,
    removeStateDir,
    resetRuntimeOperationStateForAgentReset,
  } = ctx;

  if (method === "POST" && pathname === "/api/agent/restart") {
    if (!onRestart) {
      error(
        res,
        "Restart is not supported in this mode (no restart handler registered)",
        501,
      );
      return true;
    }

    if (state.agentState === "restarting") {
      error(res, "A restart is already in progress", 409);
      return true;
    }

    const previousState = state.agentState;
    state.agentState = "restarting";
    try {
      const newRuntime = await onRestart();
      if (newRuntime) {
        state.runtime = newRuntime;
        state.chatConnectionReady = null;
        state.chatConnectionPromise = null;
        state.agentState = "running";
        state.agentName =
          newRuntime.character.name ?? resolveDefaultAgentName(state.config);
        state.model = detectRuntimeModel(newRuntime);
        state.startedAt = Date.now();
        state.pendingRestartReasons = [];
        onRuntimeSwapped?.();
        json(res, {
          ok: true,
          pendingRestart: false,
          status: {
            state: state.agentState,
            agentName: state.agentName,
            model: state.model,
            startedAt: state.startedAt,
          },
        });
      } else {
        state.agentState = previousState;
        error(
          res,
          "Restart handler returned null — runtime failed to re-initialize",
          500,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.agentState = previousState;
      error(res, `Restart failed: ${message}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/reset") {
    try {
      const bridge = getAgentHostBridge();
      const runReset =
        bridge.withCredentialStateReset ?? ((operation) => operation());
      await runReset(async () => {
        const stateDir = resolveStateDir();
        const stateResetOptions = {
          runtimeOwnsState: state.runtime !== null,
        } as const;
        validateAgentStateResetPath(stateDir, stateResetOptions);
        validateAccountAuthResetPaths();
        validateConfigEnvResetPaths({ stateDir });
        const config = loadElizaConfig();
        const workspaceDir = resolveUserPath(
          config.agents?.defaults?.workspace ??
            resolveDefaultAgentWorkspaceDir(),
        );
        validateExternalAgentStateResetPaths(
          stateDir,
          process.env,
          workspaceDir,
        );
        const dataDir = validateResetPgliteDataDir(config, stateDir);

        if (state.runtime) {
          await state.runtime.teardownForReset();
          state.runtime = null;
        }
        resetRuntimeOperationStateForAgentReset?.();

        deleteAllStoredAccountAuthState();
        cancelAllOAuthFlowsForReset();
        resetSubscriptionOAuthStateForAgentReset();
        resetCredentialRefreshStateForAgentReset();
        resetConnectorAccountStateForDestructiveReset();

        if (bridge.deleteHostCredentialStoresForReset) {
          await bridge.deleteHostCredentialStoresForReset();
        } else {
          const vault = bridge.sharedVault();
          for (const key of await vault.list()) await vault.remove(key);
          const remaining = await vault.list();
          if (remaining.length > 0) {
            throw new Error(
              `vault entries survived destructive reset: ${remaining.join(", ")}`,
            );
          }
          await vault.destroy?.();
        }

        if (stateDirExists(dataDir)) {
          validateOwnedResetTarget(
            path.dirname(dataDir),
            dataDir,
            "PGlite data",
          );
          removeStateDir(dataDir);
        }
        if (stateDirExists(dataDir)) {
          throw new Error(`PGlite data survived destructive reset: ${dataDir}`);
        }

        clearPersistedFirstRunConfig(config);
        saveElizaConfigForReset(config);
        await deleteConfigEnvForReset({ stateDir });
        deleteExternalAgentStateForReset(stateDir, process.env, workspaceDir);
        deleteAgentStateForReset(stateDir, stateResetOptions);
        saveElizaConfigForReset(config);
        if (stateResetOptions.runtimeOwnsState) {
          writeAgentStateOwnershipMarker(stateDir, stateResetOptions);
        }
        clearCloudSecrets();
        const stewardMetadataPath = resolveStewardCredentialsPath(
          process.env,
          stateDir,
        );
        validateOwnedResetTarget(
          stateDir,
          stewardMetadataPath,
          "Steward credential metadata",
        );
        fs.rmSync(stewardMetadataPath, { force: true });
        if (fs.existsSync(stewardMetadataPath)) {
          throw new Error("Steward credential metadata survived reset");
        }
        resetStewardWalletCache();

        state.agentState = "stopped";
        state.agentName = resolveDefaultAgentName(config);
        state.model = undefined;
        state.startedAt = undefined;
        state.config = config;
        state.chatRoomId = null;
        state.chatUserId = null;
        state.chatConnectionReady = null;
        state.chatConnectionPromise = null;
        state.pendingRestartReasons = [];
        state.conversations?.clear();
        state.activeConversationId = null;
        state.conversationRestorePromise = null;
      });

      res.setHeader("Set-Cookie", [
        "eliza_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        "eliza_csrf=; Path=/; SameSite=Lax; Max-Age=0",
      ]);
      json(res, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(res, `Reset failed: ${message}`, 500);
    }
    return true;
  }

  return false;
}
