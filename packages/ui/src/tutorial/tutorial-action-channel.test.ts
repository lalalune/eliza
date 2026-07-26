/**
 * Unit coverage for the tutorial action channel: reserved-prefix consumption
 * (with and without a registered handler), action value round-tripping, and
 * the exact-ish "start/stop/restart tutorial" command matcher — including the
 * sentences it must NOT swallow.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildTutorialActionValue,
  matchTutorialCommand,
  parseTutorialAction,
  setTutorialActionHandler,
  setTutorialTextHandler,
  tryHandleTutorialAction,
  tryHandleTutorialText,
} from "./tutorial-action-channel";

afterEach(() => {
  setTutorialActionHandler(null);
  setTutorialTextHandler(null);
});

describe("action values", () => {
  it("round-trips verb + step id", () => {
    const value = buildTutorialActionValue("next", "send-message");
    expect(value).toBe("__tutorial__:next:send-message");
    expect(parseTutorialAction(value)).toEqual({
      verb: "next",
      stepId: "send-message",
    });
  });

  it("rejects garbage under the reserved prefix", () => {
    expect(parseTutorialAction("__tutorial__:")).toBeNull();
    expect(parseTutorialAction("__tutorial__:next")).toBeNull();
    expect(parseTutorialAction("__tutorial__:next:")).toBeNull();
    expect(parseTutorialAction("__tutorial__:jump:welcome")).toBeNull();
    expect(parseTutorialAction("not-tutorial")).toBeNull();
  });

  it("consumes every reserved value even with no handler registered", () => {
    // A tap on a leftover tour widget in an old transcript must never become
    // a literal chat message, tour or no tour.
    expect(tryHandleTutorialAction("__tutorial__:next:welcome")).toBe(true);
    expect(tryHandleTutorialAction("__tutorial__:garbage")).toBe(true);
    expect(tryHandleTutorialAction("hello")).toBe(false);
  });

  it("dispatches parsed actions to the registered handler", () => {
    const handler = vi.fn();
    setTutorialActionHandler(handler);
    tryHandleTutorialAction("__tutorial__:stop:voice");
    expect(handler).toHaveBeenCalledWith({ verb: "stop", stepId: "voice" });
    // Unparseable values are consumed without a dispatch.
    tryHandleTutorialAction("__tutorial__:garbage");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("matchTutorialCommand", () => {
  it("matches the three commands, case-insensitively, with optional 'the' and punctuation", () => {
    expect(matchTutorialCommand("start tutorial")).toBe("start");
    expect(matchTutorialCommand("Stop Tutorial")).toBe("stop");
    expect(matchTutorialCommand("RESTART TUTORIAL!")).toBe("restart");
    expect(matchTutorialCommand("start the tutorial.")).toBe("start");
    expect(matchTutorialCommand("  stop the tutorial  ")).toBe("stop");
  });

  it("never swallows normal chat that merely mentions the tutorial", () => {
    expect(matchTutorialCommand("how do I stop the tutorial?")).toBeNull();
    expect(
      matchTutorialCommand("can you start the tutorial for me"),
    ).toBeNull();
    expect(matchTutorialCommand("tutorial")).toBeNull();
    expect(matchTutorialCommand("restart")).toBeNull();
    expect(matchTutorialCommand("start tutorials")).toBeNull();
    expect(matchTutorialCommand("start tutorial now")).toBeNull();
  });
});

describe("tryHandleTutorialText", () => {
  it("returns false with no handler (text flows to the real send)", () => {
    expect(tryHandleTutorialText("start tutorial")).toBe(false);
  });

  it("only consults the handler for exact commands", () => {
    const handler = vi.fn().mockReturnValue(true);
    setTutorialTextHandler(handler);
    expect(tryHandleTutorialText("what is the tutorial about?")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(tryHandleTutorialText("restart tutorial")).toBe(true);
    expect(handler).toHaveBeenCalledWith("restart tutorial", "restart");
  });

  it("lets the handler decline (e.g. 'stop tutorial' with no tour running)", () => {
    setTutorialTextHandler(() => false);
    expect(tryHandleTutorialText("stop tutorial")).toBe(false);
  });
});
