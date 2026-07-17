/** Verifies that credential reads distinguish missing data from store failure. */
import { describe, expect, it } from "vitest";

import { secureStoreValueOrMissing } from "./secure-store-read";

const OPTIONS = {
  kind: "wallet.evm_private_key" as const,
  operation: "test-hydrate",
};

describe("secureStoreValueOrMissing", () => {
  it("returns present values and confirmed absence", () => {
    expect(
      secureStoreValueOrMissing({ ok: true, value: "secret" }, OPTIONS),
    ).toBe("secret");
    expect(
      secureStoreValueOrMissing({ ok: false, reason: "not_found" }, OPTIONS),
    ).toBeNull();
  });

  it.each([
    ["denied", "SECURE_STORE_READ_DENIED"],
    ["unavailable", "SECURE_STORE_READ_UNAVAILABLE"],
    ["error", "SECURE_STORE_READ_FAILED"],
  ] as const)("throws a typed failure for %s", (reason, code) => {
    expect(() =>
      secureStoreValueOrMissing({ ok: false, reason }, OPTIONS),
    ).toThrowError(expect.objectContaining({ code }));
  });
});
