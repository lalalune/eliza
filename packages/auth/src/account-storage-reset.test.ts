/**
 * Destructive account-store reset against real files in an isolated home.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetAccountAuthWritesForTests,
  deleteAllStoredAccountAuthState,
  resolveAccountAuthRoot,
  resolveAccountAuthRoots,
  resolveLegacyAccountAuthArtifacts,
  runWithAccountAuthGeneration,
  saveAccount,
} from "./account-storage";

describe("deleteAllStoredAccountAuthState", () => {
  let root = "";
  let previousElizaHome: string | undefined;
  let previousStateDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    __resetAccountAuthWritesForTests();
    previousElizaHome = process.env.ELIZA_HOME;
    previousStateDir = process.env.ELIZA_STATE_DIR;
    previousHome = process.env.HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-reset-"));
    process.env.ELIZA_HOME = root;
    process.env.ELIZA_STATE_DIR = path.join(root, "state");
    process.env.HOME = path.join(root, "home");
  });

  afterEach(() => {
    __resetAccountAuthWritesForTests();
    if (previousElizaHome === undefined) delete process.env.ELIZA_HOME;
    else process.env.ELIZA_HOME = previousElizaHome;
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { force: true, recursive: true });
  });

  it("removes every owned auth root and rejects a stale async writer", async () => {
    saveAccount({
      id: "primary",
      providerId: "openai-api",
      label: "Primary",
      source: "api-key",
      credentials: { access: "secret", expires: 0, refresh: "" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const authRoots = resolveAccountAuthRoots();
    expect(authRoots).toHaveLength(2);
    for (const authRoot of authRoots) {
      fs.mkdirSync(path.join(authRoot, "_codex-home", "primary"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(authRoot, "_pool-metadata.json"), "secret");
      fs.writeFileSync(
        path.join(authRoot, "_pool-metadata.json.tmp"),
        "secret",
      );
      fs.writeFileSync(
        path.join(authRoot, "_codex-home", "primary", "auth.json"),
        "secret",
      );
    }
    const legacyArtifacts = resolveLegacyAccountAuthArtifacts();
    for (const artifact of legacyArtifacts) {
      if (path.extname(artifact)) {
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, "legacy-secret");
      } else {
        fs.mkdirSync(artifact, { recursive: true });
        fs.writeFileSync(path.join(artifact, "default.json"), "legacy-secret");
      }
    }

    deleteAllStoredAccountAuthState();

    for (const authRoot of authRoots)
      expect(fs.existsSync(authRoot)).toBe(false);
    for (const artifact of legacyArtifacts)
      expect(fs.existsSync(artifact)).toBe(false);
    let releaseLate!: () => void;
    const latePause = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const lateWrite = runWithAccountAuthGeneration(async () => {
      await latePause;
      saveAccount({
        id: "late",
        providerId: "openai-api",
        label: "Late",
        source: "api-key",
        credentials: { access: "late", expires: 0, refresh: "" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    deleteAllStoredAccountAuthState();
    releaseLate();
    await expect(lateWrite).rejects.toThrow("stale account auth write");
    for (const authRoot of authRoots)
      expect(fs.existsSync(authRoot)).toBe(false);

    saveAccount({
      id: "new",
      providerId: "openai-api",
      label: "New",
      source: "api-key",
      credentials: { access: "new", expires: 0, refresh: "" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(fs.existsSync(resolveAccountAuthRoot())).toBe(true);
  });

  it("refuses a filesystem-root home", () => {
    process.env.ELIZA_HOME = path.parse(root).root;
    expect(() => resolveAccountAuthRoot()).toThrow(
      "refusing to resolve account auth storage under a root",
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked auth-root ancestor without deleting its target",
    () => {
      const actualHome = path.join(root, "actual-account-home");
      const linkedHome = path.join(root, "linked-account-home");
      const sentinel = path.join(actualHome, "auth", "sentinel.json");
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, "secret\n");
      fs.symlinkSync(actualHome, linkedHome, "dir");
      process.env.ELIZA_HOME = linkedHome;

      expect(() => deleteAllStoredAccountAuthState()).toThrow(
        "refusing symlinked account auth reset path",
      );
      expect(fs.readFileSync(sentinel, "utf8")).toBe("secret\n");
    },
  );
});
