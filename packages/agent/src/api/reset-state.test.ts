/** Verifies destructive state cleanup against a real isolated filesystem tree. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteAgentStateForReset,
  deleteExternalAgentStateForReset,
} from "./reset-state";

describe("deleteAgentStateForReset", () => {
  const roots: string[] = [];
  const originalStateDir = process.env.ELIZA_STATE_DIR;
  const originalOAuthDir = process.env.ELIZA_OAUTH_DIR;

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
    if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = originalStateDir;
    if (originalOAuthDir === undefined) delete process.env.ELIZA_OAUTH_DIR;
    else process.env.ELIZA_OAUTH_DIR = originalOAuthDir;
  });

  it("removes credentials, attachments, databases, and staging while retaining models", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-reset-parent-"),
    );
    roots.push(parent);
    const stateDir = path.join(parent, "state");
    process.env.ELIZA_STATE_DIR = stateDir;
    const model = path.join(
      stateDir,
      "local-inference",
      "models",
      "text",
      "model.gguf",
    );
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, "model");
    const legacyModel = path.join(stateDir, "models", "legacy.gguf");
    fs.mkdirSync(path.dirname(legacyModel), { recursive: true });
    fs.writeFileSync(legacyModel, "legacy-model");
    for (const target of [
      "auth/openai-codex/account.json",
      "credentials/github.json",
      "media/private.bin",
      "internal/device-secret",
      ".elizadb/data",
      ".vault-pglite/data",
      "local-inference/registry.json",
      "local-inference/downloads/partial.gguf.part",
      "config.env",
    ]) {
      const file = path.join(stateDir, target);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "secret");
    }

    const unrelated = path.join(stateDir, "user-notes.txt");
    fs.writeFileSync(unrelated, "keep-unrelated");

    deleteAgentStateForReset(stateDir, { runtimeOwnsState: true });

    expect(fs.readFileSync(model, "utf8")).toBe("model");
    expect(fs.readFileSync(legacyModel, "utf8")).toBe("legacy-model");
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep-unrelated");
    expect(fs.readdirSync(stateDir).sort()).toEqual([
      "local-inference",
      "models",
      "user-notes.txt",
    ]);
    expect(fs.readdirSync(path.join(stateDir, "local-inference"))).toEqual([
      "models",
    ]);
  });

  it("refuses roots that could erase unrelated user or system data", () => {
    expect(() =>
      deleteAgentStateForReset(path.parse(process.cwd()).root, {
        runtimeOwnsState: true,
      }),
    ).toThrow("refusing unsafe agent state reset path");
    expect(() =>
      deleteAgentStateForReset(os.homedir(), { runtimeOwnsState: true }),
    ).toThrow("refusing unsafe agent state reset path");
    expect(() =>
      deleteAgentStateForReset(os.tmpdir(), { runtimeOwnsState: true }),
    ).toThrow("refusing unsafe agent state reset path");
  });

  it("does not erase an arbitrary deep custom directory without ownership proof", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "unowned-reset-parent-"),
    );
    roots.push(parent);
    const unowned = path.join(parent, "documents", "project");
    fs.mkdirSync(unowned, { recursive: true });
    const sentinel = path.join(unowned, "sentinel.txt");
    fs.writeFileSync(sentinel, "keep");
    process.env.ELIZA_STATE_DIR = unowned;

    expect(() => deleteAgentStateForReset(unowned)).toThrow(
      "refusing unproven custom agent state reset path",
    );
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("accepts a stopped custom state root only with an explicit ownership marker", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "owned-reset-parent-"),
    );
    roots.push(parent);
    const owned = path.join(parent, "custom", "state");
    fs.mkdirSync(owned, { recursive: true });
    fs.writeFileSync(path.join(owned, ".eliza-state-root"), "eliza\n");
    fs.mkdirSync(path.join(owned, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(owned, "credentials", "token.json"), "secret");
    process.env.ELIZA_STATE_DIR = owned;

    deleteAgentStateForReset(owned);

    expect(fs.existsSync(path.join(owned, "credentials"))).toBe(false);
    expect(fs.readFileSync(path.join(owned, ".eliza-state-root"), "utf8")).toBe(
      "eliza\n",
    );
  });

  it("removes only fixed LifeOps OAuth leaves from an external root", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "oauth-reset-parent-"),
    );
    roots.push(parent);
    const stateDir = path.join(parent, "state");
    const oauthRoot = path.join(parent, "external-oauth");
    const lifeopsToken = path.join(
      oauthRoot,
      "lifeops",
      "health",
      "token.json",
    );
    const paymentToken = path.join(
      oauthRoot,
      "lifeops",
      "payments",
      "token.json",
    );
    const lifeopsUnrelated = path.join(
      oauthRoot,
      "lifeops",
      "notes",
      "keep.json",
    );
    const unrelated = path.join(oauthRoot, "other-app", "token.json");
    for (const target of [
      lifeopsToken,
      paymentToken,
      lifeopsUnrelated,
      unrelated,
    ]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "secret");
    }

    deleteExternalAgentStateForReset(stateDir, {
      HOME: path.join(parent, "home"),
      ELIZA_OAUTH_DIR: oauthRoot,
    });

    expect(fs.existsSync(path.join(oauthRoot, "lifeops", "health"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(oauthRoot, "lifeops", "payments"))).toBe(
      false,
    );
    expect(fs.readFileSync(lifeopsUnrelated, "utf8")).toBe("secret");
    expect(fs.readFileSync(unrelated, "utf8")).toBe("secret");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked state-root ancestor without deleting owned entries",
    () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), "linked-reset-parent-"),
      );
      roots.push(parent);
      const actualParent = path.join(parent, "actual");
      const linkedParent = path.join(parent, "linked");
      const stateDir = path.join(linkedParent, "state");
      const sentinel = path.join(
        actualParent,
        "state",
        "credentials",
        "token.json",
      );
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, "secret");
      fs.symlinkSync(actualParent, linkedParent, "dir");

      expect(() =>
        deleteAgentStateForReset(stateDir, { runtimeOwnsState: true }),
      ).toThrow("refusing symlinked agent state root reset path");
      expect(fs.readFileSync(sentinel, "utf8")).toBe("secret");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked OAuth ancestor before deleting either owned leaf",
    () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), "linked-oauth-parent-"),
      );
      roots.push(parent);
      const oauthRoot = path.join(parent, "oauth");
      const external = path.join(parent, "external-lifeops");
      const sentinel = path.join(external, "health", "token.json");
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, "secret");
      fs.mkdirSync(oauthRoot, { recursive: true });
      fs.symlinkSync(external, path.join(oauthRoot, "lifeops"), "dir");

      expect(() =>
        deleteExternalAgentStateForReset(path.join(parent, "state"), {
          HOME: path.join(parent, "home"),
          ELIZA_OAUTH_DIR: oauthRoot,
        }),
      ).toThrow("refusing symlinked OAuth state reset path");
      expect(fs.readFileSync(sentinel, "utf8")).toBe("secret");
    },
  );

  it("removes only fixed ACP files and transcript leaves from broad overrides", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "external-agent-state-"),
    );
    roots.push(parent);
    const acpRoot = path.join(parent, "shared-acp");
    const sessionsRoot = path.join(parent, "shared-sessions");
    const ownedFiles = [
      path.join(acpRoot, "sessions.json"),
      path.join(acpRoot, "sessions.json.lock"),
      path.join(acpRoot, "sessions.json.42.99.tmp"),
      path.join(acpRoot, "orchestrator-tasks.json"),
      path.join(acpRoot, "orchestrator-tasks.json.42.99.tmp"),
      path.join(acpRoot, "audit.ndjson"),
      path.join(acpRoot, "audit.ndjson.1"),
      path.join(sessionsRoot, "cc-1", "transcript.log"),
    ];
    for (const target of ownedFiles) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "secret");
    }
    const acpUnrelated = path.join(acpRoot, "user-notes.txt");
    const sessionUnrelated = path.join(sessionsRoot, "cc-1", "keep.txt");
    fs.writeFileSync(acpUnrelated, "keep");
    fs.writeFileSync(sessionUnrelated, "keep");

    deleteExternalAgentStateForReset(path.join(parent, "state"), {
      HOME: path.join(parent, "home"),
      ELIZA_ACP_STATE_DIR: acpRoot,
      ELIZA_SUB_AGENT_SESSIONS_DIR: sessionsRoot,
    });

    for (const target of ownedFiles) expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(acpUnrelated, "utf8")).toBe("keep");
    expect(fs.readFileSync(sessionUnrelated, "utf8")).toBe("keep");
  });

  it("removes only fixed connector auth leaves from an external workspace", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "connector-reset-workspace-"),
    );
    roots.push(parent);
    const workspace = path.join(parent, "workspace");
    const credentialFiles = [
      path.join(workspace, "signal-auth", "default", "account.json"),
      path.join(workspace, "whatsapp-auth", "default", "creds.json"),
      path.join(workspace, "lifeops-whatsapp-auth", "default", "creds.json"),
    ];
    for (const target of credentialFiles) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "secret");
    }
    const unrelated = path.join(workspace, "project.txt");
    fs.writeFileSync(unrelated, "keep");

    deleteExternalAgentStateForReset(
      path.join(parent, "state"),
      {
        HOME: path.join(parent, "home"),
      },
      workspace,
    );

    for (const target of credentialFiles)
      expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
  });

  it("refuses an explicit connector auth directory outside the owned workspace leaf", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "connector-reset-override-"),
    );
    roots.push(parent);
    const workspace = path.join(parent, "workspace");
    const external = path.join(parent, "user-managed-signal");
    const sentinel = path.join(external, "account.json");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(sentinel, "keep");

    expect(() =>
      deleteExternalAgentStateForReset(
        path.join(parent, "state"),
        {
          HOME: path.join(parent, "home"),
          SIGNAL_AUTH_DIR: external,
        },
        workspace,
      ),
    ).toThrow("unsupported SIGNAL_AUTH_DIR");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });
});
