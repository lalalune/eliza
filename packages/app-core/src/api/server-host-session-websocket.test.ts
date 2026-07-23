/**
 * Real-socket coverage for host-owned browser sessions crossing the agent
 * WebSocket boundary while loopback trust is intentionally disabled.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startApiServer } from "./server";

const HOST_SESSION_COOKIE = "eliza_session=host-owned-session";
const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PAIRING_DISABLED",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
] as const;

type StartedServer = Awaited<ReturnType<typeof startApiServer>>;

describe("host session WebSocket authorization", () => {
  const previousEnv = new Map<string, string | undefined>();
  const checkedHostSessionCookies: Array<string | undefined> = [];
  let server: StartedServer | null = null;
  let stateDir = "";

  beforeAll(async () => {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-host-session-ws-"));
    delete process.env.ELIZA_API_TOKEN;
    process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "config.json");
    process.env.ELIZA_PAIRING_DISABLED = "1";
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_STATE_DIR = stateDir;

    setAgentHostBridge({
      ...defaultAgentHostBridge,
      resolveHttpRequestAuthorization: (request) => {
        checkedHostSessionCookies.push(request.headers.cookie);
        return {
          ok: request.headers.cookie === HOST_SESSION_COOKIE,
          role:
            request.headers.cookie === HOST_SESSION_COOKIE ? "OWNER" : "NONE",
        };
      },
    });
    server = await startApiServer({
      port: 0,
      skipDeferredStartupWork: true,
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    _resetAgentHostBridge();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function wsUrl(): string {
    if (!server) throw new Error("WebSocket test server was not started");
    return `ws://127.0.0.1:${server.port}/ws?clientId=host-session-test`;
  }

  it("keeps readiness public while data routes still require a session", async () => {
    if (!server) throw new Error("HTTP test server was not started");
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const [status, config] = await Promise.all([
      fetch(`${baseUrl}/api/status`),
      fetch(`${baseUrl}/api/config`),
    ]);

    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: expect.any(String) });
    expect(config.status).toBe(401);
  });

  it("accepts the host session and immediately emits authenticated status", async () => {
    const firstMessage = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const ws = new WebSocket(wsUrl(), {
          headers: { cookie: HOST_SESSION_COOKIE },
        });
        const timeout = setTimeout(() => {
          ws.terminate();
          reject(new Error("Timed out waiting for authenticated WS status"));
        }, 10_000);
        ws.once("error", reject);
        ws.once("message", (data: unknown) => {
          clearTimeout(timeout);
          const message = JSON.parse(String(data)) as Record<string, unknown>;
          ws.close();
          resolve(message);
        });
      },
    );

    expect(firstMessage).toMatchObject({ type: "status" });
    expect(checkedHostSessionCookies).toContain(HOST_SESSION_COOKIE);
  });

  it("still rejects a caller without a valid host session", async () => {
    const outcome = await new Promise<string>((resolve, reject) => {
      if (!server) {
        reject(new Error("WebSocket test server was not started"));
        return;
      }
      const clientScript = `
        const http = require("node:http");
        const request = http.request({
          hostname: "127.0.0.1",
          port: Number(process.argv[1]),
          path: "/ws?clientId=host-session-test",
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
            "sec-websocket-version": "13",
          },
        }, (response) => {
          process.stdout.write("status:" + String(response.statusCode ?? 0));
          response.resume();
          response.once("end", () => process.exit(0));
        });
        request.once("upgrade", () => {
          process.stderr.write("Unauthenticated WebSocket unexpectedly opened");
          process.exit(2);
        });
        request.once("error", () => {
          process.stdout.write("rejected");
          process.exit(0);
        });
        request.setTimeout(5_000, () => {
          process.stderr.write("Timed out waiting for WS upgrade rejection");
          request.destroy();
          process.exit(4);
        });
        request.end();
      `;
      const client = spawn("node", ["-e", clientScript, String(server.port)]);
      let stdout = "";
      let stderr = "";
      client.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      client.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const timeout = setTimeout(() => {
        client.kill("SIGKILL");
        reject(new Error("Timed out waiting for WS upgrade rejection"));
      }, 10_000);
      client.once("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(
              `Node WebSocket handshake client exited ${code}: ${stderr}`,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      });
    });

    expect(["status:401", "rejected"]).toContain(outcome);
    expect(checkedHostSessionCookies).toContain(undefined);
  }, 15_000);
});
