/** The loopback OAuth helper must close promptly when runtime teardown aborts authorization. */
import { describe, expect, it } from "vitest";
import { waitForLoopbackCallback } from "./interactive";

describe("interactive OAuth teardown", () => {
  it("aborts a pending loopback callback without waiting for its timeout", async () => {
    const controller = new AbortController();
    const callback = waitForLoopbackCallback(
      "http://127.0.0.1:0/callback",
      "expected-state",
      60_000,
      controller.signal,
    );

    controller.abort();

    await expect(callback).rejects.toMatchObject({ name: "AbortError" });
  });
});
