/**
 * App-chat non-streaming settlement is pinned to durable cache admission.
 *
 * Executable warm/cold/ack behavior lives in public-llm-cache-hotpath.test.ts;
 * these assertions prevent the former synchronous app-credit guard from
 * replacing the durable lease and alarm recovery contract.
 */

import { describe, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../v1/apps/[id]/chat/route.ts", import.meta.url),
).text();

describe("app chat non-streaming durable settlement", () => {
  test("marks the lease immediately before provider invocation", () => {
    const providerSetup = source.indexOf(
      "getProviderForModelWithFallback(model)",
    );
    const mark = source.indexOf("await admission.markProviderDispatched()");
    const provider = source.indexOf(
      "providerResponse = await withProviderFallback",
    );
    expect(providerSetup).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(providerSetup);
    expect(provider).toBeGreaterThan(mark);
  });

  test("malformed or unpriceable output retains conservative durable recovery", () => {
    expect(source).toContain("responseData = await providerResponse.json()");
    expect(source).toContain('settle("unknown")');
    expect(source).toContain("settleOffResponsePath(executionCtx");
    expect(source).not.toContain("appCreditsService");
    expect(source).not.toContain("requireAuthOrApiKeyWithOrg");
  });
});
