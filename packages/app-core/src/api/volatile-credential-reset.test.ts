/**
 * Exercises destructive reset against the real process singletons, in-memory
 * capability store, wake bearer file, and vault facades with isolated vaults.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ChannelType, resolveSensitiveRequestDelivery } from "@elizaos/core";
import { createManager, createTestVault, type TestVault } from "@elizaos/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSecretsManagerInstaller,
  SecretsManagerInstaller,
} from "../services/secrets-manager-installer";
import {
  _resetSharedVaultForTesting,
  sharedVault,
} from "../services/vault-mirror";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  __resetWakeTelemetryForTests,
  __setDeviceSecretForTests,
  __setDeviceSecretPathForTests,
  getDeviceSecret,
  getWakeTelemetry,
  handleInternalWakeRoute,
} from "./internal-routes";
import {
  _getSecretsManagerForTesting,
  _resetSecretsManagerForTesting,
} from "./secrets-manager-routes";
import { resetSensitiveRequestsForAgentReset } from "./sensitive-request-routes";
import { localSensitiveRequestStore } from "./sensitive-request-store";
import { resetVolatileCredentialStateForAgentReset } from "./volatile-credential-reset";

const OLD_DEVICE_SECRET = "old-device-secret-0123456789abcdef0123456789abcdef";

function fakeWakeRequest(secret: string): http.IncomingMessage {
  const request = new http.IncomingMessage(new Socket());
  request.method = "POST";
  request.url = "/api/internal/wake";
  request.headers = { authorization: `Bearer ${secret}` };
  (request as { body?: unknown }).body = {
    kind: "refresh",
    deadlineMs: Date.now() + 5_000,
  };
  return request;
}

function fakeResponse(): {
  response: http.ServerResponse;
  status: () => number;
} {
  const request = new http.IncomingMessage(new Socket());
  const response = new http.ServerResponse(request);
  response.setHeader = () => response;
  response.end = (() => response) as typeof response.end;
  return { response, status: () => response.statusCode };
}

function runtimeState(): CompatRuntimeState {
  return {
    current: {
      getService: () => ({ runDueTasks: async () => undefined }),
    } as unknown as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

describe("volatile credential reset", () => {
  const vaults: TestVault[] = [];
  const temporaryRoots: string[] = [];
  const originalDeviceSecret = process.env.ELIZA_DEVICE_SECRET;

  afterEach(async () => {
    _resetSecretsManagerForTesting();
    _resetSharedVaultForTesting();
    resetSensitiveRequestsForAgentReset();
    __resetWakeTelemetryForTests();
    __setDeviceSecretForTests(null);
    __setDeviceSecretPathForTests(null);
    if (originalDeviceSecret === undefined) {
      delete process.env.ELIZA_DEVICE_SECRET;
    } else {
      process.env.ELIZA_DEVICE_SECRET = originalDeviceSecret;
    }
    await Promise.all(vaults.splice(0).map((vault) => vault.dispose()));
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  async function trackedVault(): Promise<TestVault> {
    const vault = await createTestVault();
    vaults.push(vault);
    return vault;
  }

  it("invalidates retired managers, submit tokens, and the wake bearer", async () => {
    const firstVault = await trackedVault();
    const secondVault = await trackedVault();
    _resetSharedVaultForTesting(firstVault.vault);
    const retiredManager = _getSecretsManagerForTesting();
    const retiredInstaller = getSecretsManagerInstaller(retiredManager);

    const delivery = resolveSensitiveRequestDelivery({
      kind: "secret",
      channelType: ChannelType.DM,
      environment: { dm: { available: true } },
    });
    const pending = localSensitiveRequestStore.create({
      kind: "secret",
      agentId: "reset-test-agent",
      target: { kind: "secret", key: "RESET_TEST_SECRET" },
      policy: delivery.policy,
      delivery,
    });
    expect(
      localSensitiveRequestStore.checkSubmitToken(
        pending.record.id,
        pending.submitToken,
      ),
    ).toMatchObject({ ok: true });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "volatile-reset-"));
    temporaryRoots.push(root);
    const deviceSecretPath = path.join(root, "internal", "device-secret");
    fs.mkdirSync(path.dirname(deviceSecretPath), { recursive: true });
    fs.writeFileSync(deviceSecretPath, `${OLD_DEVICE_SECRET}\n`, {
      mode: 0o600,
    });
    __setDeviceSecretPathForTests(deviceSecretPath);
    process.env.ELIZA_DEVICE_SECRET = OLD_DEVICE_SECRET;
    expect(getDeviceSecret()).toBe(OLD_DEVICE_SECRET);
    const beforeReset = fakeResponse();
    await handleInternalWakeRoute(
      fakeWakeRequest(OLD_DEVICE_SECRET),
      beforeReset.response,
      runtimeState(),
    );
    expect(beforeReset.status()).toBe(200);
    expect(getWakeTelemetry().lastWakeFiredAt).not.toBeNull();

    resetVolatileCredentialStateForAgentReset();

    expect(() =>
      retiredInstaller.startInstall("bitwarden", {
        kind: "npm",
        package: "@bitwarden/cli",
      }),
    ).toThrow("closed for agent reset");
    expect(
      localSensitiveRequestStore.checkSubmitToken(
        pending.record.id,
        pending.submitToken,
      ),
    ).toEqual({ ok: false, status: 404, reason: "not_found" });
    expect(process.env.ELIZA_DEVICE_SECRET).toBeUndefined();
    expect(fs.existsSync(deviceSecretPath)).toBe(false);
    expect(getWakeTelemetry()).toEqual({
      lastWakeFiredAt: null,
      lastWakeKind: null,
      lastWakeDurationMs: null,
      lastWakeError: null,
    });

    _resetSharedVaultForTesting(secondVault.vault);
    const freshManager = _getSecretsManagerForTesting();
    const freshInstaller = getSecretsManagerInstaller(freshManager);
    expect(freshManager).not.toBe(retiredManager);
    expect(freshInstaller).not.toBe(retiredInstaller);
    expect(sharedVault()).toBe(secondVault.vault);

    const freshDeviceSecret = getDeviceSecret();
    expect(freshDeviceSecret).not.toBe(OLD_DEVICE_SECRET);
    const oldBearer = fakeResponse();
    await handleInternalWakeRoute(
      fakeWakeRequest(OLD_DEVICE_SECRET),
      oldBearer.response,
      runtimeState(),
    );
    expect(oldBearer.status()).toBe(401);
  });

  it("kills active installer jobs and rejects late use of their vault facade", async () => {
    const testVault = await trackedVault();
    const manager = createManager({ vault: testVault.vault });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
    });
    const kill = vi.fn(() => true);
    child.kill = kill as ChildProcess["kill"];
    const installer = new SecretsManagerInstaller({
      manager,
      spawn: () => child,
    });
    const job = installer.startInstall("bitwarden", {
      kind: "npm",
      package: "@bitwarden/cli",
    });
    const event = vi.fn();
    installer.subscribeJob(job.id, event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    installer.closeForAgentReset();

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(event).toHaveBeenCalledWith({
      type: "error",
      message: "Agent reset",
    });
    expect(installer.getJob(job.id)).toBeNull();
    await expect(installer.getSession("bitwarden")).rejects.toThrow(
      "closed for agent reset",
    );
  });
});
