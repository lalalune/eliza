/**
 * Exercises the standalone agent reset's destructive database-path preflight
 * against a real filesystem tree without starting a runtime.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __agentAdminResetPathTesting } from "./agent-admin-routes.ts";

describe("agent reset PGlite path preflight", () => {
  const roots: string[] = [];
  const savedPgliteDataDir = process.env.PGLITE_DATA_DIR;

  afterEach(() => {
    if (savedPgliteDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
    else process.env.PGLITE_DATA_DIR = savedPgliteDataDir;
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked existing ancestor",
    () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "agent-reset-pglite-"),
      );
      roots.push(root);
      const stateDir = path.join(root, "state");
      const externalWorkspace = path.join(root, "external-workspace");
      const linkedWorkspace = path.join(stateDir, "linked-workspace");
      fs.mkdirSync(path.join(externalWorkspace, ".elizadb"), {
        recursive: true,
      });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.symlinkSync(externalWorkspace, linkedWorkspace, "dir");
      process.env.PGLITE_DATA_DIR = path.join(linkedWorkspace, ".elizadb");

      expect(() =>
        __agentAdminResetPathTesting.validateResetPgliteDataDir(
          {
            agents: { defaults: { workspace: linkedWorkspace } },
          } as Parameters<
            typeof __agentAdminResetPathTesting.validateResetPgliteDataDir
          >[0],
          stateDir,
        ),
      ).toThrow("refusing symlinked PGlite data reset path");
    },
  );
});
