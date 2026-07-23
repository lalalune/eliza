/**
 * Fail-closed outcome tests for the live Cloud onboarding proof script.
 */

import { describe, expect, test } from "bun:test";
import { validateRealCloudOnboardingOutcome } from "./_real-cloud-onboarding.mjs";

function passingOutcome(overrides = {}) {
  return {
    nonceStatus: 200,
    nonceDomain: "api.elizacloud.ai",
    nonce: "nonce",
    verifyStatus: 200,
    token: "api-key",
    createStatus: 202,
    agentId: "agent-id",
    firstChatOk: 0,
    readyAt: 73,
    cleanupStatus: 202,
    cleanupError: null,
    ...overrides,
  };
}

describe("real Cloud onboarding outcome", () => {
  test("passes only with auth, agent, first chat, readiness, and cleanup", () => {
    expect(validateRealCloudOnboardingOutcome(passingOutcome())).toEqual({
      passed: true,
      firstChatSeconds: 0,
      dedicatedReadySeconds: 73,
      cleanupStatus: 202,
    });
  });

  test.each([
    ["missing SIWE token", { token: null }],
    ["missing agent id", { agentId: null }],
    ["chat never worked", { firstChatOk: null }],
    ["dedicated readiness timed out", { readyAt: null }],
    ["cleanup rejected", { cleanupStatus: 500 }],
    ["cleanup threw", { cleanupError: "network down" }],
  ])("fails when %s", (_name, override) => {
    expect(() =>
      validateRealCloudOnboardingOutcome(passingOutcome(override)),
    ).toThrow("Real Cloud onboarding proof failed");
  });
});
