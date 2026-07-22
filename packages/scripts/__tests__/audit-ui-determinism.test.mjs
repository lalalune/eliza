/**
 * Runs the UI determinism audit's built-in parser regression matrix in-process
 * so its main-only script remains covered by the changed-file gate.
 */

import { afterEach, expect, it, vi } from "vitest";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
});

it("classifies async declarations and methods as deferred work", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`unexpected process.exit(${code})`);
  });
  process.argv = [...originalArgv, "--self-test"];

  await import("../audit-ui-determinism.mjs");

  expect(exit).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("OK async function declaration deferred");
  expect(log).toHaveBeenCalledWith("OK async method deferred");
  expect(log).toHaveBeenCalledWith("\nself-test PASSED");
});
