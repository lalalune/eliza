/**
 * Pure verdict logic for the iOS simulator voice round-trip lane
 * (`ios-voice-selftest-smoke.mjs`). Kept dependency-free so it is the single
 * source of truth for "did the REAL mic->ASR->agent->TTS loop pass?" shared by
 * the in-app WKWebView verifier (which mirrors this check to signal early) and
 * the host-side orchestrator (which re-derives the verdict from the raw report
 * as the authoritative hard gate), and unit-tested by
 * `ios-voice-selftest-lib.test.mjs`.
 *
 * The no-false-green contract matches `voice-selftest.android.spec.ts`: overall
 * must be `pass` AND each of the asr/send/tts stages must be `pass`. A `skipped`
 * stage (e.g. local-inference ASR not provisioned) is NOT a pass — it fails the
 * lane loudly so "can't run here" never reads as "verified working".
 */

/** The three stages every real voice round-trip must clear, in order. */
export const REQUIRED_VOICE_STAGES = ["asr", "send", "tts"];

/**
 * Reduce a {@link VoiceSelfTestReport}-shaped object to a hard pass/fail verdict
 * with human-readable reasons for every failing check. Returns `pass:false`
 * (never throws) for a missing/corrupt report so the caller can surface the raw
 * payload; the orchestrator turns `pass:false` into a nonzero exit.
 *
 * @param {unknown} report Parsed voice self-test report (or null/garbage).
 * @returns {{ pass: boolean, reasons: string[], stageStatuses: Record<string,string>, transcript: string, reply: string, overall: string }}
 */
export function evaluateVoiceSelfTestReport(report) {
  const reasons = [];
  if (!report || typeof report !== "object") {
    return {
      pass: false,
      reasons: ["report is missing or not an object"],
      stageStatuses: {},
      transcript: "",
      reply: "",
      overall: "unknown",
    };
  }

  const overall =
    typeof report.overall === "string" ? report.overall : "unknown";
  const transcript =
    typeof report.transcript === "string" ? report.transcript : "";
  const reply = typeof report.reply === "string" ? report.reply : "";
  const stages = Array.isArray(report.stages) ? report.stages : [];

  const stageStatuses = {};
  for (const stage of stages) {
    if (stage && typeof stage.stage === "string") {
      stageStatuses[stage.stage] =
        typeof stage.status === "string" ? stage.status : "unknown";
    }
  }

  if (overall !== "pass") {
    reasons.push(`overall is "${overall}", expected "pass"`);
  }

  for (const name of REQUIRED_VOICE_STAGES) {
    const status = stageStatuses[name];
    if (status === undefined) {
      reasons.push(`stage "${name}" is missing from the report`);
    } else if (status !== "pass") {
      // A skipped stage fails just like a failed one — parity with the Android
      // spec's no-false-green rule.
      reasons.push(`stage "${name}" is "${status}", expected "pass"`);
    }
  }

  // The fixture says "what time is it"; a real transcript must contain "time",
  // and a real agent turn must produce a non-empty reply.
  if (!transcript.toLowerCase().includes("time")) {
    reasons.push(
      `transcript ${JSON.stringify(transcript)} does not contain "time"`,
    );
  }
  if (reply.trim().length === 0) {
    reasons.push("agent reply is empty");
  }

  return {
    pass: reasons.length === 0,
    reasons,
    stageStatuses,
    transcript,
    reply,
    overall,
  };
}
