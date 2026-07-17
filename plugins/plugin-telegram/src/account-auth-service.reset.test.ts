/** Verifies Telegram account reads stay side-effect-free around reset. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTelegramAccountSessionString,
  resolveTelegramAccountSessionFile,
  telegramAccountAuthStateExists,
  telegramAccountSessionExists,
} from "./account-auth-service.ts";

describe("Telegram account reset-safe reads", () => {
  const previousStateDir = process.env.ELIZA_STATE_DIR;
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-reset-read-"));
    fs.rmSync(stateDir, { recursive: true, force: true });
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
  });

  it("does not recreate the state tree while checking absent auth", () => {
    expect(resolveTelegramAccountSessionFile()).toBe(
      path.join(stateDir, "telegram-account", "session.txt"),
    );
    expect(loadTelegramAccountSessionString()).toBe("");
    expect(telegramAccountSessionExists()).toBe(false);
    expect(telegramAccountAuthStateExists()).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  });
});
