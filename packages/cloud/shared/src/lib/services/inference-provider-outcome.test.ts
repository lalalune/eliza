/**
 * Verifies only explicit caller/auth/rate-limit rejections qualify for a
 * known-zero settlement after provider dispatch.
 */

import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { isKnownUnacceptedProviderError } from "./inference-provider-outcome";

function providerError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider returned ${statusCode}`,
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
  });
}

describe("isKnownUnacceptedProviderError", () => {
  test.each([400, 401, 402, 403, 404, 413, 422, 429])(
    "classifies explicit %i rejection as unaccepted",
    (status) => {
      expect(isKnownUnacceptedProviderError(providerError(status))).toBe(true);
    },
  );

  test.each([408, 499, 500, 503, 529])(
    "keeps ambiguous %i outcomes conservative",
    (status) => {
      expect(isKnownUnacceptedProviderError(providerError(status))).toBe(false);
    },
  );

  test("keeps transport failures conservative", () => {
    expect(isKnownUnacceptedProviderError(new TypeError("network reset"))).toBe(
      false,
    );
  });
});
