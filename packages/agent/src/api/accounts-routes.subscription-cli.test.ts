/**
 * Exercises the subscription CLI bootstrap with deterministic install, failure,
 * cooldown, PATH, and concurrency seams rather than invoking npm or OAuth.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  __clearSubscriptionCliInstallFailures,
  ensureSubscriptionCli,
} from "./accounts-routes";

const stateDir = mkdtempSync(path.join(tmpdir(), "eliza-state-"));
const prevStateDir = process.env.ELIZA_STATE_DIR;
const prevPath = process.env.PATH;
process.env.ELIZA_STATE_DIR = stateDir;

const expectedPrefix = path.join(stateDir, "tools", "subscription-cli");
const expectedBinDir = path.join(expectedPrefix, "node_modules", ".bin");

beforeEach(() => {
  __clearSubscriptionCliInstallFailures();
  process.env.PATH = prevPath;
});

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  process.env.PATH = prevPath;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ensureSubscriptionCli (#16518)", () => {
  it("installs into the user-writable state-dir prefix, never -g", async () => {
    const installs: string[][] = [];
    let installed = false;
    await ensureSubscriptionCli("anthropic-subscription", {
      isAvailable: async () => installed,
      runInstall: async (args) => {
        installs.push(args);
        installed = true;
      },
    });

    expect(installs).toHaveLength(1);
    expect(installs[0]).toEqual([
      "install",
      "--prefix",
      expectedPrefix,
      "--no-fund",
      "--no-audit",
      "@anthropic-ai/claude-code",
    ]);
    expect(installs[0]).not.toContain("-g");
  });

  it("deduplicates concurrent bootstrap attempts into one install", async () => {
    let installs = 0;
    let installed = false;
    let releaseInstall: (() => void) | undefined;
    let notifyInstallStarted: (() => void) | undefined;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const installStarted = new Promise<void>((resolve) => {
      notifyInstallStarted = resolve;
    });
    const deps = {
      isAvailable: async () => installed,
      runInstall: async () => {
        installs += 1;
        notifyInstallStarted?.();
        await installGate;
        installed = true;
      },
    };

    const first = ensureSubscriptionCli("anthropic-subscription", deps);
    const second = ensureSubscriptionCli("anthropic-subscription", deps);
    await installStarted;
    expect(installs).toBe(1);

    releaseInstall?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(installs).toBe(1);
  });

  it("serializes distinct CLI installs that mutate the shared prefix", async () => {
    const installed = new Set<string>();
    const events: string[] = [];
    let activeInstalls = 0;
    let maxActiveInstalls = 0;
    let releaseClaudeInstall: (() => void) | undefined;
    let notifyClaudeInstallStarted: (() => void) | undefined;
    const claudeInstallGate = new Promise<void>((resolve) => {
      releaseClaudeInstall = resolve;
    });
    const claudeInstallStarted = new Promise<void>((resolve) => {
      notifyClaudeInstallStarted = resolve;
    });
    const isAvailable = async (command: string) => installed.has(command);
    const runInstall = async (args: string[]) => {
      const packageName = args.at(-1);
      const command = packageName === "@openai/codex" ? "codex" : "claude";
      activeInstalls += 1;
      maxActiveInstalls = Math.max(maxActiveInstalls, activeInstalls);
      events.push(`start:${command}`);
      try {
        if (command === "claude") {
          notifyClaudeInstallStarted?.();
          await claudeInstallGate;
        }
        installed.add(command);
        events.push(`end:${command}`);
      } finally {
        activeInstalls -= 1;
      }
    };

    const claude = ensureSubscriptionCli("anthropic-subscription", {
      isAvailable,
      runInstall,
    });
    const codex = ensureSubscriptionCli("openai-codex", {
      isAvailable,
      runInstall,
    });
    await claudeInstallStarted;

    expect(events).toEqual(["start:claude"]);
    expect(maxActiveInstalls).toBe(1);
    releaseClaudeInstall?.();
    await expect(Promise.all([claude, codex])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(events).toEqual([
      "start:claude",
      "end:claude",
      "start:codex",
      "end:codex",
    ]);
    expect(maxActiveInstalls).toBe(1);
  });

  it("makes the tools bin dir visible on PATH for the later bare spawn, idempotently", async () => {
    await ensureSubscriptionCli("openai-codex", {
      isAvailable: async () => true,
      runInstall: async () => {
        throw new Error("must not install when available");
      },
    });
    const parts = (process.env.PATH ?? "").split(path.delimiter);
    expect(parts[0]).toBe(expectedBinDir);

    // Second call must not duplicate the entry.
    await ensureSubscriptionCli("openai-codex", {
      isAvailable: async () => true,
    });
    const again = (process.env.PATH ?? "").split(path.delimiter);
    expect(again.filter((p) => p === expectedBinDir)).toHaveLength(1);
  });

  it("a failed install throws a structured prerequisite error with actionable context", async () => {
    const cause = new Error(
      "EACCES: permission denied, mkdir '/usr/lib/node_modules'",
    );
    const attempt = ensureSubscriptionCli("anthropic-subscription", {
      isAvailable: async () => false,
      runInstall: async () => {
        throw cause;
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(ElizaError);
    await attempt.catch((error: ElizaError) => {
      expect(error.code).toBe("SUBSCRIPTION_CLI_INSTALL_FAILED");
      expect(error.context).toMatchObject({
        command: "claude",
        packageName: "@anthropic-ai/claude-code",
        prefix: expectedPrefix,
      });
      expect(String(error.context?.causeMessage)).toContain("EACCES");
      expect(error.cause).toBe(cause);
    });
  });

  it("does NOT re-run a failed install on the next attempt within the cooldown — and retries after it", async () => {
    let installs = 0;
    let clock = 1_000_000;
    const deps = {
      isAvailable: async () => false,
      runInstall: async () => {
        installs += 1;
        throw new Error("EACCES");
      },
      now: () => clock,
    };

    await expect(ensureSubscriptionCli("openai-codex", deps)).rejects.toThrow(
      "could not be installed",
    );
    expect(installs).toBe(1);

    // Immediate retry (the next OAuth attempt): same structured error, no
    // second guaranteed-to-fail npm run.
    await expect(ensureSubscriptionCli("openai-codex", deps)).rejects.toThrow(
      "could not be installed",
    );
    expect(installs).toBe(1);

    // After the cooldown elapses, a repaired environment gets a fresh attempt.
    clock += 5 * 60 * 1000 + 1;
    await expect(ensureSubscriptionCli("openai-codex", deps)).rejects.toThrow();
    expect(installs).toBe(2);
  });

  it("installed-but-not-on-PATH throws its own structured error", async () => {
    const attempt = ensureSubscriptionCli("openai-codex", {
      isAvailable: async () => false,
      runInstall: async () => undefined,
    });
    await expect(attempt).rejects.toBeInstanceOf(ElizaError);
    await attempt.catch((error: ElizaError) => {
      expect(error.code).toBe("SUBSCRIPTION_CLI_NOT_ON_PATH");
      expect(error.context).toMatchObject({
        command: "codex",
        binDir: expectedBinDir,
      });
    });
  });

  it("a success after a prior failure clears the cached failure", async () => {
    let clock = 1_000_000;
    let works = false;
    let installs = 0;
    const deps = {
      isAvailable: async () => works,
      runInstall: async () => {
        installs += 1;
        if (!works && installs === 1) throw new Error("EACCES");
        works = true;
      },
      now: () => clock,
    };

    await expect(
      ensureSubscriptionCli("anthropic-subscription", deps),
    ).rejects.toThrow();
    clock += 5 * 60 * 1000 + 1;
    await ensureSubscriptionCli("anthropic-subscription", deps);
    expect(installs).toBe(2);

    // The cache is clean: a later missing-CLI state re-installs immediately.
    works = false;
    await expect(
      ensureSubscriptionCli("anthropic-subscription", {
        ...deps,
        runInstall: async () => {
          installs += 1;
          works = true;
        },
      }),
    ).resolves.toBeUndefined();
    expect(installs).toBe(3);
  });
});
