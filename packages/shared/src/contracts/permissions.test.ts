/**
 * Verifies the runtime permission-status guard used by transport boundaries.
 */
import { describe, expect, it } from "vitest";
import { isPermissionStatus, PERMISSION_STATUSES } from "./permissions.js";

describe("permission status contract", () => {
  it("accepts every canonical status, including privacy-opaque decisions", () => {
    for (const status of PERMISSION_STATUSES) {
      expect(isPermissionStatus(status)).toBe(true);
    }
    expect(PERMISSION_STATUSES).toContain("opaque");
  });

  it("rejects native-only and malformed values", () => {
    expect(isPermissionStatus("determined")).toBe(false);
    expect(isPermissionStatus("prompt")).toBe(false);
    expect(isPermissionStatus(null)).toBe(false);
  });
});
