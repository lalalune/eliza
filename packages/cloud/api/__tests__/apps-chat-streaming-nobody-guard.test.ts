/**
 * App-chat streaming failures retain the durable admission lease until exact
 * usage is known or the alarm recovers it. The executable route harness covers
 * provider dispatch; these assertions pin no-body and interruption handling.
 */

import { describe, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../v1/apps/[id]/chat/route.ts", import.meta.url),
).text();

describe("app chat streaming durable settlement", () => {
  test("a provider with no body settles unknown and returns a closed error stream", () => {
    const noReader = source.indexOf("if (!reader) {");
    const unknown = source.indexOf('settle("unknown")', noReader);
    const done = source.indexOf("[DONE]", noReader);
    expect(noReader).toBeGreaterThan(-1);
    expect(unknown).toBeGreaterThan(noReader);
    expect(done).toBeGreaterThan(unknown);
  });

  test("stream processing is retained by waitUntil and interruption settles unknown", () => {
    expect(source).toContain("executionCtx.waitUntil(processStream)");
    expect(source).toContain("await admission.settleUnknown()");
    expect(source).not.toContain("reconcileStreamProcessingError");
    expect(source).not.toContain("appCreditsService");
  });
});
