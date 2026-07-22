/**
 * Drives the iOS onboarding harness in-process through its complete simulator
 * protocol. Device process and capture boundaries are substituted while the
 * production transport-result validator remains in the exercised path.
 */

import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";

const harness = {
  assertInstalledIosAppRendererFresh: mock(),
  assertLiveReply: mock(),
  captureIosSimulatorScreenshot: mock(
    ({ filename }) => `/evidence/${filename}`,
  ),
  clearIosSmokeDefaults: mock(),
  execFileSync: mock(),
  spawnSync: mock(() => ({ status: 0, stdout: "", stderr: "" })),
  startDeviceE2eHostAgent: mock(),
  startIosSimulatorVideo: mock(),
};

mock.module("node:child_process", () => ({
  default: {
    execFileSync: harness.execFileSync,
    spawnSync: harness.spawnSync,
  },
  execFileSync: harness.execFileSync,
  spawnSync: harness.spawnSync,
}));
mock.module("../test/liveness-contract.mjs", () => ({
  assertLiveReply: harness.assertLiveReply,
}));
mock.module("./lib/host-agent.mjs", () => ({
  DEFAULT_HOST_AGENT_PORT: 31338,
  startDeviceE2eHostAgent: harness.startDeviceE2eHostAgent,
}));
mock.module("./lib/ios-renderer-stamp.mjs", () => ({
  assertCandidateIosAppRendererFresh: mock(),
  assertInstalledIosAppRendererFresh:
    harness.assertInstalledIosAppRendererFresh,
}));
mock.module("./lib/ios-sim-defaults-hygiene.mjs", () => ({
  clearIosSmokeDefaults: harness.clearIosSmokeDefaults,
}));
mock.module("./lib/ios-simulator-capture.mjs", () => ({
  captureIosSimulatorScreenshot: harness.captureIosSimulatorScreenshot,
  startIosSimulatorVideo: harness.startIosSimulatorVideo,
}));

const originalArgv = [...process.argv];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalAttempts = process.env.IOS_ONBOARDING_SMOKE_ATTEMPTS;
const originalDelay = process.env.IOS_ONBOARDING_SMOKE_DELAY_MS;
let mkdirSpy;
let writeFileSpy;

const apiBase = "http://127.0.0.1:31338";
const onboardingResult = {
  ok: true,
  phase: "complete",
  homeVisible: true,
  composerVisible: true,
  onboardingHidden: true,
  storage: {
    "elizaos:active-server": JSON.stringify({ kind: "remote", apiBase }),
  },
};
const mixedContentResult = {
  ok: true,
  phase: "complete",
  webViewOrigin: "capacitor://localhost",
  mixedContentWouldBlockWebSocket: false,
  expectedWebSocketUrl: "ws://127.0.0.1:31338/ws",
  webSocketExpected: true,
  webSocketConstructorCalls: ["ws://127.0.0.1:31338/ws?clientId=ios-smoke"],
  webSocketOpenCalls: ["ws://127.0.0.1:31338/ws?clientId=ios-smoke"],
  connectionState: { state: "connected" },
  lostBackendOverlayAbsent: true,
  restHealth: { ok: true },
};
const relaunchResult = {
  ok: true,
  phase: "complete",
  homeVisible: true,
  composerVisible: true,
  onboardingHidden: true,
};

function preferenceResult(args) {
  const key = String(args.at(-1));
  if (key.includes("eliza:ios-onboarding-relaunch-smoke:result")) {
    return JSON.stringify(relaunchResult);
  }
  if (key.includes("eliza:ios-mixed-content-smoke:result")) {
    return JSON.stringify(mixedContentResult);
  }
  if (key.includes("eliza:ios-onboarding-smoke:result")) {
    return JSON.stringify(onboardingResult);
  }
  return null;
}

async function waitForAssertion(assertion, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError ?? new Error("Timed out waiting for assertion");
}

beforeEach(() => {
  for (const fn of Object.values(harness)) {
    fn.mockClear();
  }
  process.argv = [
    "node",
    "ios-onboarding-smoke.mjs",
    "--api-base",
    apiBase,
    "--skip-install",
    "--no-video",
  ];
  process.env.IOS_ONBOARDING_SMOKE_ATTEMPTS = "2";
  process.env.IOS_ONBOARDING_SMOKE_DELAY_MS = "0";
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  harness.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  harness.execFileSync.mockImplementation((_command, args) => {
    if (args.join(" ").includes("list devices booted --json")) {
      return JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS": [
            { state: "Booted", udid: "SIM-UDID" },
          ],
        },
      });
    }
    if (args.includes("get_app_container")) {
      throw new Error("container path intentionally unavailable");
    }
    const result = preferenceResult(args);
    if (result !== null) return result;
    return "";
  });
  mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  writeFileSpy = spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
});

afterEach(() => {
  process.argv = [...originalArgv];
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalAttempts === undefined) {
    delete process.env.IOS_ONBOARDING_SMOKE_ATTEMPTS;
  } else {
    process.env.IOS_ONBOARDING_SMOKE_ATTEMPTS = originalAttempts;
  }
  if (originalDelay === undefined) {
    delete process.env.IOS_ONBOARDING_SMOKE_DELAY_MS;
  } else {
    process.env.IOS_ONBOARDING_SMOKE_DELAY_MS = originalDelay;
  }
  mock.restore();
});

it("accepts completed transport evidence and writes the reviewed result artifact", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`unexpected process.exit(${code})`);
  });

  await import("./ios-onboarding-smoke.mjs");

  await waitForAssertion(() => {
    expect(
      log.mock.calls.flat().some((value) => String(value).includes("PASS")),
    ).toBe(true);
  });
  expect(exit).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(harness.startDeviceE2eHostAgent).not.toHaveBeenCalled();
  expect(harness.assertInstalledIosAppRendererFresh).toHaveBeenCalledWith(
    expect.objectContaining({ udid: "SIM-UDID", bundleId: "ai.elizaos.app" }),
  );
  expect(mkdirSpy).toHaveBeenCalled();
  expect(writeFileSpy).toHaveBeenCalledWith(
    expect.stringContaining("result.json"),
    expect.stringContaining('"mixedContent"'),
  );
  const artifact = JSON.parse(writeFileSpy.mock.calls.at(-1)[1]);
  expect(artifact).toMatchObject({
    homeVisible: true,
    mixedContent: mixedContentResult,
    coldRelaunch: relaunchResult,
  });
});
