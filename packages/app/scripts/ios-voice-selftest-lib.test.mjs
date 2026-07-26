/**
 * Unit tests for the pure verdict logic of the iOS voice round-trip lane
 * (`evaluateVoiceSelfTestReport`). Deterministic — no simulator, no device, no
 * model; exercises the no-false-green contract (skipped != pass, transcript +
 * reply presence) that gates `ios-voice-selftest-smoke.mjs`. Runs in the
 * packages/app vitest suite (root `test:client` lane).
 */
import { describe, expect, it } from "vitest";
import {
  evaluateVoiceSelfTestReport,
  REQUIRED_VOICE_STAGES,
} from "./ios-voice-selftest-lib.mjs";

function stage(name, status) {
  return { stage: name, status, durationMs: 1, detail: {} };
}

function passingReport(overrides = {}) {
  return {
    schemaVersion: 1,
    overall: "pass",
    platform: "ios",
    mode: "wav-direct",
    ttsRoute: "/api/tts/local-inference",
    expectedPhrase: "what time is it",
    transcript: "what time is it",
    reply: "It is 3 o'clock.",
    stages: [stage("asr", "pass"), stage("send", "pass"), stage("tts", "pass")],
    ...overrides,
  };
}

describe("evaluateVoiceSelfTestReport", () => {
  it("passes a fully green real round-trip", () => {
    const verdict = evaluateVoiceSelfTestReport(passingReport());
    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.stageStatuses).toEqual({
      asr: "pass",
      send: "pass",
      tts: "pass",
    });
    expect(verdict.transcript).toBe("what time is it");
    expect(verdict.reply).toBe("It is 3 o'clock.");
  });

  it("requires the three real pipeline stages", () => {
    expect(REQUIRED_VOICE_STAGES).toEqual(["asr", "send", "tts"]);
  });

  it("fails loudly when the ASR stage is skipped (not provisioned)", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "fail",
        stages: [
          stage("asr", "skipped"),
          stage("send", "skipped"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      'stage "asr" is "skipped", expected "pass"',
    );
  });

  it("treats an all-skipped overall=skipped report as a failure", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "skipped",
        stages: [
          stage("asr", "skipped"),
          stage("send", "skipped"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('overall is "skipped", expected "pass"');
  });

  it("fails when the agent send stage fails", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "fail",
        reply: "",
        stages: [
          stage("asr", "pass"),
          stage("send", "fail"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      'stage "send" is "fail", expected "pass"',
    );
    expect(verdict.reasons).toContain("agent reply is empty");
  });

  it("fails when the transcript does not contain the expected phrase word", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({ transcript: "banana bread please" }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("does not contain"))).toBe(
      true,
    );
  });

  it("fails when a required stage is entirely absent", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({ stages: [stage("asr", "pass"), stage("send", "pass")] }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('stage "tts" is missing from the report');
  });

  it("does not throw on a missing/garbage report", () => {
    expect(evaluateVoiceSelfTestReport(null).pass).toBe(false);
    expect(evaluateVoiceSelfTestReport(undefined).pass).toBe(false);
    expect(evaluateVoiceSelfTestReport("nope").pass).toBe(false);
    expect(evaluateVoiceSelfTestReport(42).pass).toBe(false);
  });

  it("fails when overall is pass but a stage silently regressed to fail", () => {
    // Defends against trusting `overall` alone — the stage grid is authoritative.
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        stages: [
          stage("asr", "pass"),
          stage("send", "pass"),
          stage("tts", "fail"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('stage "tts" is "fail", expected "pass"');
  });
});
