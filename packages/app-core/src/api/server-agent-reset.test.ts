/**
 * Drives the real compat dispatcher through the agent-reset failure boundary.
 * A secure-store cleanup failure returns 500 while keeping the successfully
 * stopped runtime out of status responses.
 */

import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompatRuntimeState } from "./compat-route-shared";
import {
  _setDeleteAgentSecretsForResetForTests,
  handleElizaCompatRoute,
} from "./server";

const API_TOKEN = "reset-test-token";
let savedApiToken: string | undefined;
let savedRequireAuth: string | undefined;
const deleteWalletSecrets = vi.fn<() => Promise<void>>();
const ISOLATED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "ELIZA_HOME",
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_OAUTH_DIR",
  "ELIZA_ACP_STATE_DIR",
  "ELIZA_SUB_AGENT_SESSIONS_DIR",
  "ELIZA_WORKSPACE_DIR",
  "SIGNAL_AUTH_DIR",
  "WHATSAPP_AUTH_DIR",
  "WHATSAPP_SESSION_PATH",
  "PGLITE_DATA_DIR",
  "POSTGRES_URL",
  "DATABASE_URL",
  "ELIZA_DEVICE_SECRET",
] as const;
let temporaryRoot = "";
let savedIsolationEnv: Partial<
  Record<(typeof ISOLATED_ENV_KEYS)[number], string>
>;

beforeEach(() => {
  savedIsolationEnv = {};
  for (const key of ISOLATED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) savedIsolationEnv[key] = value;
  }
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "server-reset-test-"));
  const home = path.join(temporaryRoot, "home");
  const stateDir = path.join(temporaryRoot, "state");
  const configPath = path.join(stateDir, "eliza.json");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ELIZA_HOME = stateDir;
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_OAUTH_DIR = path.join(stateDir, "credentials");
  process.env.PGLITE_DATA_DIR = path.join(stateDir, ".elizadb");
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  delete process.env.ELIZA_DEVICE_SECRET;
  savedApiToken = process.env.ELIZA_API_TOKEN;
  savedRequireAuth = process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
  deleteWalletSecrets.mockRejectedValue(
    new Error("secure-store cleanup failed"),
  );
  _setDeleteAgentSecretsForResetForTests(deleteWalletSecrets);
});

afterEach(() => {
  if (savedApiToken === undefined) delete process.env.ELIZA_API_TOKEN;
  else process.env.ELIZA_API_TOKEN = savedApiToken;
  if (savedRequireAuth === undefined) {
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  } else {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = savedRequireAuth;
  }
  _setDeleteAgentSecretsForResetForTests(null);
  for (const key of ISOLATED_ENV_KEYS) {
    const value = savedIsolationEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
  vi.clearAllMocks();
});

function resetRequest(): http.IncomingMessage {
  const request = new http.IncomingMessage(new Socket());
  request.method = "POST";
  request.url = "/api/agent/reset";
  request.headers = {
    authorization: `Bearer ${API_TOKEN}`,
    host: "127.0.0.1:2138",
  };
  request.push("{}");
  request.push(null);
  Object.defineProperty(request.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return request;
}

function captureResponse() {
  let body = "";
  const request = new http.IncomingMessage(new Socket());
  const response = new http.ServerResponse(request);
  const socket = new Socket();
  response.assignSocket(socket);
  response.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    socket.destroy();
    return response;
  }) as typeof response.end;
  return {
    response,
    status: () => response.statusCode,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

describe("POST /api/agent/reset", () => {
  it.skipIf(process.platform === "win32")(
    "rejects a symlinked PGlite path before stopping or deleting credentials",
    async () => {
      const externalDatabase = path.join(temporaryRoot, "external-database");
      const externalSentinel = path.join(externalDatabase, "sentinel.txt");
      fs.mkdirSync(externalDatabase, { recursive: true });
      fs.writeFileSync(externalSentinel, "keep\n");
      fs.symlinkSync(externalDatabase, process.env.PGLITE_DATA_DIR as string);

      const teardownForReset = vi.fn(async () => undefined);
      const state: CompatRuntimeState = {
        current: {
          teardownForReset,
        } as unknown as CompatRuntimeState["current"],
        pendingAgentName: null,
        pendingRestartReasons: [],
      };
      const capture = captureResponse();

      const handled = await handleElizaCompatRoute(
        resetRequest(),
        capture.response,
        state,
      );

      expect(handled).toBe(true);
      expect(capture.status()).toBe(500);
      expect(capture.json()).toEqual({
        error: "refusing symlinked PGlite reset path",
      });
      expect(teardownForReset).not.toHaveBeenCalled();
      expect(deleteWalletSecrets).not.toHaveBeenCalled();
      expect(state.current).not.toBeNull();
      expect(fs.readFileSync(externalSentinel, "utf8")).toBe("keep\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked PGlite ancestor before stopping or deleting credentials",
    async () => {
      const stateDir = process.env.ELIZA_STATE_DIR as string;
      const externalDatabase = path.join(
        temporaryRoot,
        "external-workspace",
        ".elizadb",
      );
      const externalSentinel = path.join(externalDatabase, "sentinel.txt");
      fs.mkdirSync(externalDatabase, { recursive: true });
      fs.writeFileSync(externalSentinel, "keep\n");
      const linkedWorkspace = path.join(stateDir, "linked-workspace");
      fs.symlinkSync(path.dirname(externalDatabase), linkedWorkspace, "dir");
      process.env.PGLITE_DATA_DIR = path.join(linkedWorkspace, ".elizadb");

      const stop = vi.fn(async () => undefined);
      const state: CompatRuntimeState = {
        current: { stop } as unknown as CompatRuntimeState["current"],
        pendingAgentName: null,
        pendingRestartReasons: [],
      };
      const capture = captureResponse();

      const handled = await handleElizaCompatRoute(
        resetRequest(),
        capture.response,
        state,
      );

      expect(handled).toBe(true);
      expect(capture.status()).toBe(500);
      expect(capture.json()).toEqual({
        error: "refusing symlinked PGlite reset path",
      });
      expect(stop).not.toHaveBeenCalled();
      expect(deleteWalletSecrets).not.toHaveBeenCalled();
      expect(state.current).not.toBeNull();
      expect(fs.readFileSync(externalSentinel, "utf8")).toBe("keep\n");
    },
  );

  it("fails before destructive reset work when wallet cleanup fails", async () => {
    const teardownForReset = vi.fn(async () => undefined);
    const runtimeMarker = {
      marker: "stopped-before-cleanup",
      teardownForReset,
    };
    const state: CompatRuntimeState = {
      current: runtimeMarker as unknown as CompatRuntimeState["current"],
      pendingAgentName: null,
      pendingRestartReasons: [],
    };
    const capture = captureResponse();

    const handled = await handleElizaCompatRoute(
      resetRequest(),
      capture.response,
      state,
    );

    expect(handled).toBe(true);
    expect(capture.status()).toBe(500);
    expect(capture.json()).toEqual({ error: "secure-store cleanup failed" });
    expect(teardownForReset).toHaveBeenCalledOnce();
    expect(deleteWalletSecrets).toHaveBeenCalledOnce();
    expect(state.current).toBeNull();
  });

  it("expires browser session cookies after a successful reset", async () => {
    deleteWalletSecrets.mockResolvedValueOnce(undefined);
    const teardownForReset = vi.fn(async () => undefined);
    const state: CompatRuntimeState = {
      current: { teardownForReset } as unknown as CompatRuntimeState["current"],
      pendingAgentName: null,
      pendingRestartReasons: [],
    };
    const capture = captureResponse();

    const handled = await handleElizaCompatRoute(
      resetRequest(),
      capture.response,
      state,
    );

    expect(handled).toBe(true);
    expect(capture.status()).toBe(200);
    expect(capture.json()).toEqual({ ok: true });
    expect(capture.response.getHeader("set-cookie")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("eliza_session="),
        expect.stringContaining("eliza_csrf="),
      ]),
    );
    for (const cookie of capture.response.getHeader("set-cookie") as string[]) {
      expect(cookie).toContain("Max-Age=0");
    }
  });
});
