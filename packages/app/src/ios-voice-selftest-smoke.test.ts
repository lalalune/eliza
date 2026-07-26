/**
 * Exercises the native Preferences handshake for the iOS voice self-test smoke
 * from jsdom. The real simulator lane owns ASR, agent, and TTS proof; this test
 * protects the host contract that every staged request ends with a terminal
 * result for the orchestrator to poll.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIosVoiceSelfTestSmokeIfRequested } from "./ios-voice-selftest-smoke";

const mocks = vi.hoisted(() => ({
  runVoiceSelfTest: vi.fn(),
}));

vi.mock("@elizaos/ui/voice", () => ({
  EXPECTED_PHRASE: "what time is it",
  KNOWN_PHRASE_WAV_DATA_URL: "data:audio/wav;base64,AA==",
  runVoiceSelfTest: mocks.runVoiceSelfTest,
}));

describe("runIosVoiceSelfTestSmokeIfRequested", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("writes a terminal failed result when the staged request JSON is malformed", async () => {
    const writes: Array<[string, Record<string, unknown>]> = [];
    const removals: string[] = [];
    window.localStorage.setItem(
      "eliza:ios-voice-selftest:request",
      "{not-json",
    );

    const started = await runIosVoiceSelfTestSmokeIfRequested({
      isIOS: true,
      client: {} as never,
      getPreference: vi.fn(async () => null),
      removePreference: vi.fn(async (key) => {
        removals.push(key);
      }),
      writeResult: vi.fn(async (key, result) => {
        writes.push([key, result]);
      }),
      readStorageSnapshot: () => ({ request: "{not-json" }),
    });

    expect(started).toBe(true);
    expect(mocks.runVoiceSelfTest).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("eliza:ios-voice-selftest:result");
    expect(writes[0][1]).toMatchObject({
      ok: false,
      phase: "failed",
      apiBase: "http://127.0.0.1:31338",
    });
    expect(String(writes[0][1].error)).toContain(
      "Invalid iOS voice self-test request",
    );
    expect(
      window.localStorage.getItem("eliza:ios-voice-selftest:request"),
    ).toBe(null);
    expect(removals).toEqual(["eliza:ios-voice-selftest:request"]);
  });
});
