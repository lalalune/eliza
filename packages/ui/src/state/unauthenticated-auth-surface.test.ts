/**
 * Verifies the top-level auth surface decision used by web and native shells,
 * including the managed-Cloud localhost case that has no valid local password.
 */

import { describe, expect, it } from "vitest";
import { resolveUnauthenticatedAuthSurface } from "./unauthenticated-auth-surface";

describe("resolveUnauthenticatedAuthSurface", () => {
  it("holds the shell while managed-Cloud re-pairing is in flight", () => {
    expect(resolveUnauthenticatedAuthSurface("recovering", false)).toBe(
      "recovering",
    );
  });

  it("renders Cloud sign-in for a native localhost Cloud session", () => {
    expect(
      resolveUnauthenticatedAuthSurface("cloud-sign-in-required", false),
    ).toBe("cloud-sign-in");
  });

  it("renders Cloud sign-in on a hosted agent origin", () => {
    expect(resolveUnauthenticatedAuthSurface("idle", true)).toBe(
      "cloud-sign-in",
    );
  });

  it("keeps the local password form for self-hosted agents", () => {
    expect(resolveUnauthenticatedAuthSurface("idle", false)).toBe(
      "local-login",
    );
  });
});
