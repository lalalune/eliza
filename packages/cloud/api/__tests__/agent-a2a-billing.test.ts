/**
 * A2A source-level billing invariants complement the executable cache-hotpath
 * route harness. They pin the durable admission/dispatch/settlement sequence
 * and prevent the retired synchronous credits path from returning.
 */

import { describe, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../agents/[id]/a2a/route.ts", import.meta.url),
).text();

describe("Agent A2A durable billing boundary", () => {
  test("uses cache authorization and durable admission before provider dispatch", () => {
    expect(source).toContain("resolveInferenceAuthContext(c.req.raw");
    expect(source).toContain("cacheOnly: true");
    expect(source).toContain("charactersService.getByIdCacheOnly");
    expect(source).toContain("admitOrganizationInference({");

    const admission = source.indexOf(
      "admission = await admitOrganizationInference",
    );
    const mark = source.indexOf("await admission.markProviderDispatched()");
    const provider = source.indexOf("const result = await streamText({");
    expect(admission).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(admission);
    expect(provider).toBeGreaterThan(mark);
  });

  test("pins creator recovery policy and settles outside the response path", () => {
    expect(source).toContain(
      "[AGENT_INFERENCE_RECOVERY_METADATA_KEY]: creatorPolicy",
    );
    expect(source).toContain("afterDebitBeforeLeaseRelease:");
    expect(source).toContain("settleOffResponsePath(authUser.executionCtx");
    expect(source).not.toContain("creditsService.reserve");
    expect(source).not.toContain("requireUserOrApiKeyWithOrg");
  });
});
