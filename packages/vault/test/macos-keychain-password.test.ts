/**
 * Exercises the macOS Keychain password PTY protocol against a fake security
 * executable, so prompt handling and process secrecy are proven without
 * reading or mutating the host Keychain.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeKeychainPromptBudget,
  KEYCHAIN_EXPECT_WAIT_STAGES,
  KEYCHAIN_HARD_DEADLINE_GRACE_MS,
  MacOSKeychainPasswordWriteError,
  writeMacOSKeychainPassword,
} from "../src/macos-keychain-password.js";

const EXPECT_PATH = "/usr/bin/expect";
const STTY_PATH = "/bin/stty";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("computeKeychainPromptBudget", () => {
  it("splits the total budget across the three expect wait stages", () => {
    const budget = computeKeychainPromptBudget(10_000);
    expect(budget.stageTimeoutMs).toBe(3_334);
    // Expect rounds 3334ms up to 4 whole seconds per stage; the hard deadline
    // must cover all three rounded stages plus the grace window.
    expect(budget.hardDeadlineMs).toBe(
      3 * 4_000 + KEYCHAIN_HARD_DEADLINE_GRACE_MS,
    );
  });

  it("keeps sub-stage budgets at least one millisecond", () => {
    expect(computeKeychainPromptBudget(1).stageTimeoutMs).toBe(1);
    expect(computeKeychainPromptBudget(2).stageTimeoutMs).toBe(1);
  });

  it("never lets the Node hard deadline preempt expect's own stage timeouts", () => {
    // The expect script rounds its per-stage timeout up to whole seconds, so
    // a run can legitimately occupy stages × roundedStageSeconds before expect
    // reports its own structured timeout. The SIGKILL deadline must sit beyond
    // that worst case for every budget, or slow-but-legitimate interactions
    // die mid-stage without diagnostics.
    for (const timeoutMs of [1, 100, 750, 1_000, 2_500, 10_000, 60_000]) {
      const budget = computeKeychainPromptBudget(timeoutMs);
      const expectWorstCaseMs =
        KEYCHAIN_EXPECT_WAIT_STAGES *
        Math.ceil(budget.stageTimeoutMs / 1000) *
        1000;
      expect(budget.hardDeadlineMs).toBeGreaterThan(expectWorstCaseMs);
    }
  });
});

describe("writeMacOSKeychainPassword input validation", () => {
  it("rejects empty and multiline passwords before spawning", () => {
    expect(() => writeMacOSKeychainPassword("service", "account", "")).toThrow(
      /non-empty single line/,
    );
    expect(() =>
      writeMacOSKeychainPassword("service", "account", "line-one\nline-two"),
    ).toThrow(/non-empty single line/);
  });

  it("surfaces expect spawn errors", async () => {
    await expect(
      writeMacOSKeychainPassword("service", "account", "stdin-only-secret", {
        expectExecutable: "/path/that/does/not/exist/expect",
      }),
    ).rejects.toThrow(/failed to start macOS Keychain prompt helper/);
  });
});

describe.runIf(process.platform !== "win32")(
  "writeMacOSKeychainPassword expect budget wiring",
  () => {
    let testDir = "";

    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), "eliza-keychain-budget-test-"));
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it("hands expect the per-stage share of the total budget", async () => {
      const reportPath = join(testDir, "env-report.json");
      const fakeExpect = join(testDir, "fake-expect.mjs");
      await writeFile(
        fakeExpect,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(
  ${JSON.stringify(reportPath)},
  JSON.stringify({ timeoutMs: process.env.ELIZA_KEYCHAIN_EXPECT_TIMEOUT_MS }),
);
process.exit(0);
`,
        "utf8",
      );
      await chmod(fakeExpect, 0o700);

      await writeMacOSKeychainPassword(
        "unit-test-service",
        "unit-test-account",
        "stdin-only-secret",
        { expectExecutable: fakeExpect, timeoutMs: 10_000 },
      );

      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        timeoutMs: string;
      };
      expect(report.timeoutMs).toBe(
        String(computeKeychainPromptBudget(10_000).stageTimeoutMs),
      );
    });
  },
);

describe.runIf(process.platform === "darwin")(
  "writeMacOSKeychainPassword PTY protocol",
  () => {
    let testDir = "";

    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), "eliza-keychain-pty-test-"));
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    async function createFakeSecurity(
      mode: "success" | "exit" | "missing-retype" | "timeout",
    ): Promise<string> {
      const executable = join(testDir, `fake-security-${mode}.mjs`);
      const source = `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const mode = ${JSON.stringify(mode)};
if (mode === "timeout") {
  setTimeout(() => {}, 30000);
} else {
  const accountIndex = process.argv.indexOf("-a");
  const reportPath = accountIndex >= 0 ? process.argv[accountIndex + 1] : "";
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const setEcho = (enabled) =>
    spawnSync(${JSON.stringify(STTY_PATH)}, [enabled ? "echo" : "-echo"], {
      stdio: ["inherit", "ignore", "inherit"],
    });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  setEcho(false);
  process.stdout.write("password data for new item: ");
  const first = (await iterator.next()).value ?? "";

  if (mode === "missing-retype") {
    setEcho(true);
    lines.close();
    process.exit(0);
  }

  process.stdout.write("retype password for new item: ");
  const second = (await iterator.next()).value ?? "";
  setEcho(true);
  lines.close();

  const argvLeak = process.argv.slice(2).some((value) => value.includes(first));
  const envLeak = Object.values(process.env).some(
    (value) => typeof value === "string" && value.includes(first),
  );
  if (reportPath) {
    writeFileSync(
      reportPath,
      JSON.stringify({
        argv: process.argv.slice(2),
        argvLeak,
        envLeak,
        firstDigest: hash(first),
        secondDigest: hash(second),
      }),
    );
  }

  if (mode === "exit") {
    process.stderr.write(\`simulated keychain rejection: \${first}\\n\`);
    process.exit(52);
  }
}
`;
      await writeFile(executable, source, "utf8");
      await chmod(executable, 0o700);
      return executable;
    }

    it("delivers the password only on stdin and answers both exact prompts", async () => {
      const password = `pty-only-${randomUUID()}`;
      const reportPath = join(testDir, "success-report.json");
      const securityExecutable = await createFakeSecurity("success");

      await writeMacOSKeychainPassword(
        "unit-test-service",
        reportPath,
        password,
        {
          expectExecutable: EXPECT_PATH,
          securityExecutable,
          timeoutMs: 2_000,
        },
      );

      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        argv: string[];
        argvLeak: boolean;
        envLeak: boolean;
        firstDigest: string;
        secondDigest: string;
      };
      expect(report.argv).toEqual([
        "add-generic-password",
        "-s",
        "unit-test-service",
        "-a",
        reportPath,
        "-U",
        "-w",
      ]);
      expect(report.argvLeak).toBe(false);
      expect(report.envLeak).toBe(false);
      expect(report.firstDigest).toBe(digest(password));
      expect(report.secondDigest).toBe(digest(password));
    });

    it("preserves exit diagnostics while redacting secret output", async () => {
      const password = `redact-${randomUUID()}`;
      const reportPath = join(testDir, "exit-report.json");
      const securityExecutable = await createFakeSecurity("exit");

      let failure: unknown;
      try {
        await writeMacOSKeychainPassword(
          "unit-test-service",
          reportPath,
          password,
          {
            expectExecutable: EXPECT_PATH,
            securityExecutable,
            timeoutMs: 2_000,
          },
        );
      } catch (err) {
        failure = err;
      }

      expect(failure).toBeInstanceOf(MacOSKeychainPasswordWriteError);
      const error = failure as MacOSKeychainPasswordWriteError;
      expect(error.code).toBe(52);
      expect(error.message).toContain("simulated keychain rejection");
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(password);
      expect(error.stderr).not.toContain(password);
    });

    it("fails when security exits before the retype prompt", async () => {
      const securityExecutable = await createFakeSecurity("missing-retype");
      await expect(
        writeMacOSKeychainPassword(
          "unit-test-service",
          join(testDir, "missing-report.json"),
          `missing-${randomUUID()}`,
          {
            expectExecutable: EXPECT_PATH,
            securityExecutable,
            timeoutMs: 2_000,
          },
        ),
      ).rejects.toMatchObject({ code: 70 });
    });

    it("terminates a command that never emits the first prompt", async () => {
      const securityExecutable = await createFakeSecurity("timeout");
      await expect(
        writeMacOSKeychainPassword(
          "unit-test-service",
          join(testDir, "timeout-report.json"),
          `timeout-${randomUUID()}`,
          {
            expectExecutable: EXPECT_PATH,
            securityExecutable,
            timeoutMs: 100,
          },
        ),
      ).rejects.toMatchObject({ code: 124 });
    });
  },
);
