#!/usr/bin/env node
/** Exercises changed-source/test classification against a real throwaway Git history. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const script = join(root, "scripts/security/coverage-changed-files.sh");
const nonstandardLiveManifestPath = join(
  root,
  "scripts/security/coverage-nonstandard-live-tests.txt",
);
const nonstandardLiveEntries = readFileSync(nonstandardLiveManifestPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const nonstandardLiveShapeFixtures = [
  "packages/demo/src/calendar.live-llm.test.ts",
  "packages/demo/src/integration.macos.test.ts",
  "packages/demo/src/multilingual-action-routing.integration.test.ts",
  "packages/demo/src/orchestrator-grilling-live-gemma.test.ts",
  "packages/demo/src/voice-kokoro-whisper-live.test.ts",
];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function write(cwd, relPath, contents) {
  const full = join(cwd, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

// Parse the `name<<EOF\n...\nEOF` heredoc blocks the script emits so assertions
// read against the same shape GitHub Actions stores into step outputs.
function parseOutput(stdout) {
  const sections = {};
  const lines = stdout.split("\n");
  let key = null;
  let buf = [];
  for (const line of lines) {
    if (key === null) {
      const m = line.match(/^(\w+)<<EOF$/);
      if (m) {
        key = m[1];
        buf = [];
      }
      continue;
    }
    if (line === "EOF") {
      sections[key] = buf.filter((l) => l !== "");
      key = null;
      continue;
    }
    buf.push(line);
  }
  return sections;
}

function spawnScript(cwd, base, head, subprocessManifest, liveTestManifest) {
  return spawnSync("bash", [script, base, head], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      COVERAGE_SUBPROCESS_SOURCE_MANIFEST: subprocessManifest,
      COVERAGE_NONSTANDARD_LIVE_TEST_MANIFEST: liveTestManifest,
    },
  });
}

function runScript(cwd, base, head, subprocessManifest, liveTestManifest) {
  const result = spawnScript(
    cwd,
    base,
    head,
    subprocessManifest,
    liveTestManifest,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseOutput(result.stdout);
}

function assertCase(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

assertCase(
  "nonstandard live-test manifest is sorted, unique, and tracked",
  () => {
    assert.deepEqual(
      nonstandardLiveEntries,
      [...new Set(nonstandardLiveEntries)].sort(),
    );
    for (const entry of nonstandardLiveEntries) {
      assert.match(entry, /\.(?:test|spec)\./);
      assert.ok(existsSync(join(root, entry)), `${entry} does not exist`);
      assert.equal(git(root, "ls-files", "--error-unmatch", entry), entry);
    }
  },
);

const dir = mkdtempSync(join(tmpdir(), "coverage-changed-"));
try {
  const subprocessManifest = join(dir, "coverage-subprocess-sources.txt");
  const liveTestManifest = join(dir, "coverage-nonstandard-live-tests.txt");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "checkout", "-q", "-b", "develop");

  // Merge-base commit: the point the feature branch forks from.
  write(dir, "packages/demo/src/base.ts", "export const base = 1;\n");
  write(
    dir,
    "packages/demo/src/runtime-equivalent.ts",
    "export const stable: number = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/runtime-changed.ts",
    "export const changed: number = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/vite-directive.ts",
    'export const load = () => import("./module");\n',
  );
  write(
    dir,
    "packages/demo/src/coverage-directive.ts",
    "export const covered: number = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/decorator-metadata.ts",
    "class Example { @field value: string; }\n",
  );
  write(dir, "packages/demo/src/deleted.ts", "export const removed = 1;\n");
  write(
    dir,
    "coverage-subprocess-sources.txt",
    "packages/demo/src/process-entrypoint.mjs\n",
  );
  write(
    dir,
    "coverage-nonstandard-live-tests.txt",
    [...nonstandardLiveEntries, ...nonstandardLiveShapeFixtures, ""]
      .sort()
      .join("\n"),
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const mergeBase = git(dir, "rev-parse", "HEAD");

  // develop advances with a file the feature branch never touches.
  write(dir, "packages/demo/src/develop-only.ts", "export const d = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "develop advances");
  const developTip = git(dir, "rev-parse", "HEAD"); // BASE (event-time develop tip)

  // Feature branch forks from the merge-base and adds its own source + tests.
  git(dir, "checkout", "-q", "-b", "feature", mergeBase);
  rmSync(join(dir, "packages/demo/src/deleted.ts"));
  write(
    dir,
    "packages/demo/src/runtime-equivalent.ts",
    "export   const stable : number | string = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/runtime-changed.ts",
    "export const changed: number = 2;\n",
  );
  write(
    dir,
    "packages/demo/src/vite-directive.ts",
    'export const load = () => import(/* @vite-ignore */ "./module");\n',
  );
  write(
    dir,
    "packages/demo/src/coverage-directive.ts",
    "/* c8 ignore next */\nexport const covered: number = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/decorator-metadata.ts",
    "class Example { @field value: number; }\n",
  );
  write(dir, "packages/demo/src/feature.ts", "export const f = 1;\n");
  write(
    dir,
    "packages/demo/src/types.ts",
    "export interface RuntimeFree { id: string }\n",
  );
  write(
    dir,
    "packages/demo/src/public.d.ts",
    "export interface PublicType { id: string }\n",
  );
  write(dir, "packages/demo/src/runtime.mjs", "export const mjs = 1;\n");
  write(dir, "packages/demo/src/runtime.cjs", "exports.cjs = 1;\n");
  write(
    dir,
    "packages/demo/src/process-entrypoint.mjs",
    "process.stdout.write('process entrypoint');\n",
  );
  write(
    dir,
    "packages/demo/src/_router.generated.ts",
    "export const generatedRoute = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/generated/schema.ts",
    "export const generatedSchema = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/runtime.mts",
    "export const mts: number = 1;\n",
  );
  write(
    dir,
    "packages/demo/src/runtime.cts",
    "export const cts: number = 1;\n",
  );
  write(
    dir,
    "packages/app/scripts/walkthrough-e2e.mjs",
    "export async function runWalkthrough() {}\n",
  );
  write(
    dir,
    "packages/app-core/scripts/playwright-ui-live-stack.ts",
    "export async function startLiveStack() {}\n",
  );
  write(
    dir,
    "scripts/security/tool.self-test.mjs",
    "throw new Error('self-test only');\n",
  );
  write(
    dir,
    "scripts/security/coverage-gate.self-test.mjs",
    "process.stdout.write('registered self-test ran');\n",
  );
  write(
    dir,
    "plugins/plugin-demo/vitest.config.ts",
    "export default { test: { include: ['scripts/**/*.test.mjs'] } };\n",
  );
  write(
    dir,
    "plugins/plugin-demo/vite.config.views.ts",
    "export default { build: { outDir: 'dist/views' } };\n",
  );
  write(
    dir,
    "plugins/plugin-demo/vitest.harness.config.ts",
    "export default { test: { include: ['__tests__/**/*.harness.test.ts'] } };\n",
  );
  write(
    dir,
    "packages/demo/src/feature.test.ts",
    "import { test } from 'vitest';\ntest('f', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/native.test.ts",
    "import { test } from 'bun:test';\ntest('n', () => {});\n",
  );
  write(
    dir,
    "packages/demo/test/e2e/flow.test.ts",
    "import { test } from 'bun:test';\ntest('e2e', () => {});\n",
  );
  write(
    dir,
    "packages/homepage/tests/e2e/visual.spec.ts",
    "import { test } from 'playwright/test';\ntest('visual', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/driver.real.test.ts",
    "import { test } from 'vitest';\ntest('real driver', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/calendar.live-llm.test.ts",
    "import { test } from 'vitest';\ntest('live model', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/orchestrator-grilling-live-gemma.test.ts",
    "import { test } from 'vitest';\ntest('live model', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/multilingual-action-routing.integration.test.ts",
    "import { test } from 'vitest';\ntest('live model', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/integration.macos.test.ts",
    "import { test } from 'vitest';\ntest('host integration', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/voice-kokoro-whisper-live.test.ts",
    "import { test } from 'bun:test';\ntest('live voice', () => {});\n",
  );
  for (const liveSuite of nonstandardLiveEntries) {
    const source = readFileSync(join(root, liveSuite), "utf8");
    const runner = /from ['"]vitest['"]|require\(['"]vitest['"]\)/.test(source)
      ? "vitest"
      : "bun:test";
    write(
      dir,
      liveSuite,
      `import { test } from '${runner}';\ntest('manifested live suite', () => {});\n`,
    );
  }
  write(
    dir,
    "packages/demo/src/real-live-suites.test.ts",
    "import { test } from 'vitest';\ntest('manifest audit', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/meeting-live.test.ts",
    "import { test } from 'vitest';\ntest('deterministic meeting state', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/store.real-db.test.ts",
    "import { test } from 'vitest';\ntest('in-memory database', () => {});\n",
  );
  write(
    dir,
    "packages/test/cloud-e2e/tests/live-deploy.spec.ts",
    "import { test } from '../src/helpers/test-fixtures';\ntest('live', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/__e2e__/fixture.tsx",
    "export const Fixture = () => null;\n",
  );
  write(
    dir,
    "packages/demo/src/feature.stories.tsx",
    "export default { title: 'Feature' };\n",
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature work");
  const featureTip = git(dir, "rev-parse", "HEAD"); // HEAD

  const out = runScript(
    dir,
    developTip,
    featureTip,
    subprocessManifest,
    liveTestManifest,
  );

  assertCase("missing nonstandard live-test manifest fails closed", () => {
    const missingManifest = join(dir, "missing-live-test-manifest.txt");
    const result = spawnScript(
      dir,
      developTip,
      featureTip,
      subprocessManifest,
      missingManifest,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing nonstandard live-test manifest/);
  });

  assertCase(
    "three-dot diff excludes develop-side files (issue #15845)",
    () => {
      // Prove the hazard is real: a plain two-dot diff would drag the develop-only
      // file into the changed set.
      const twoDot = git(
        dir,
        "diff",
        "--name-only",
        developTip,
        featureTip,
      ).split("\n");
      assert.ok(
        twoDot.includes("packages/demo/src/develop-only.ts"),
        "expected two-dot diff to include the develop-side file",
      );
      // The script uses three-dot, so it must not.
      assert.ok(
        !out.files.includes("packages/demo/src/develop-only.ts"),
        `develop-side file leaked into changed source: ${out.files.join(",")}`,
      );
      assert.ok(
        out.files.includes("packages/demo/src/feature.ts"),
        `feature source missing from changed set: ${out.files.join(",")}`,
      );
    },
  );

  assertCase(
    "e2e directory tests excluded from unit lanes (issue #15845)",
    () => {
      assert.ok(
        !out.bun_tests.includes("packages/demo/test/e2e/flow.test.ts"),
        `e2e-dir test leaked into bun lane: ${out.bun_tests.join(",")}`,
      );
      assert.ok(
        !out.vitest_tests.includes("packages/demo/test/e2e/flow.test.ts"),
        `e2e-dir test leaked into vitest lane: ${out.vitest_tests.join(",")}`,
      );
      assert.ok(
        !out.bun_tests.includes("packages/homepage/tests/e2e/visual.spec.ts"),
        `Playwright spec leaked into bun lane: ${out.bun_tests.join(",")}`,
      );
      assert.ok(
        !out.vitest_tests.includes(
          "packages/homepage/tests/e2e/visual.spec.ts",
        ),
        `Playwright spec leaked into vitest lane: ${out.vitest_tests.join(",")}`,
      );
    },
  );

  assertCase("real-driver suites stay in their dedicated lane", () => {
    const realSuite = "packages/demo/src/driver.real.test.ts";
    assert.ok(
      !out.bun_tests.includes(realSuite),
      `real suite leaked into bun lane: ${out.bun_tests.join(",")}`,
    );
    assert.ok(
      !out.vitest_tests.includes(realSuite),
      `real suite leaked into vitest lane: ${out.vitest_tests.join(",")}`,
    );
  });

  assertCase(
    "manifested nonstandard live suites stay in their dedicated lane",
    () => {
      for (const liveSuite of [
        ...nonstandardLiveEntries,
        ...nonstandardLiveShapeFixtures,
      ]) {
        assert.ok(!out.bun_tests.includes(liveSuite));
        assert.ok(!out.vitest_tests.includes(liveSuite));
      }
      for (const deterministicLookalike of [
        "packages/demo/src/meeting-live.test.ts",
        "packages/demo/src/real-live-suites.test.ts",
        "packages/demo/src/store.real-db.test.ts",
      ]) {
        assert.ok(
          out.vitest_tests.includes(deterministicLookalike),
          `${deterministicLookalike} must remain in the Vitest lane`,
        );
      }
    },
  );

  assertCase("cloud Playwright specs stay in their dedicated lane", () => {
    const liveSpec = "packages/test/cloud-e2e/tests/live-deploy.spec.ts";
    assert.ok(
      !out.bun_tests.includes(liveSpec),
      `cloud Playwright spec leaked into bun lane: ${out.bun_tests.join(",")}`,
    );
    assert.ok(
      !out.vitest_tests.includes(liveSpec),
      `cloud Playwright spec leaked into vitest lane: ${out.vitest_tests.join(",")}`,
    );
  });

  assertCase(
    "e2e fixtures and stories are not product coverage targets",
    () => {
      assert.ok(!out.files.includes("packages/demo/src/__e2e__/fixture.tsx"));
      assert.ok(!out.files.includes("packages/demo/src/feature.stories.tsx"));
      assert.ok(
        !out.files.includes("packages/app/scripts/walkthrough-e2e.mjs"),
      );
      assert.ok(
        !out.files.includes(
          "packages/app-core/scripts/playwright-ui-live-stack.ts",
        ),
      );
    },
  );

  assertCase("unit tests bucket by imported runner", () => {
    assert.ok(
      out.bun_tests.includes("packages/demo/src/native.test.ts"),
      `bun-native test missing: ${out.bun_tests.join(",")}`,
    );
    assert.ok(
      !out.bun_tests.includes("packages/demo/src/feature.test.ts"),
      "vitest test wrongly in bun lane",
    );
    assert.ok(
      out.vitest_tests.includes("packages/demo/src/feature.test.ts"),
      `vitest test missing: ${out.vitest_tests.join(",")}`,
    );
  });

  assertCase("Vite config changes are not LCOV-enforced source", () => {
    assert.ok(
      !out.files.includes("plugins/plugin-demo/vitest.config.ts"),
      `vitest config leaked into changed source: ${out.files.join(",")}`,
    );
    assert.ok(
      !out.files.includes("plugins/plugin-demo/vite.config.views.ts"),
      `Vite config leaked into changed source: ${out.files.join(",")}`,
    );
    // The harness-lane config convention run-changed-vitest-coverage.mjs
    // defines (HARNESS_CONFIG_NAME) — a config file, never coverable source.
    assert.ok(
      !out.files.includes("plugins/plugin-demo/vitest.harness.config.ts"),
      `vitest harness config leaked into changed source: ${out.files.join(",")}`,
    );
  });

  assertCase("generated modules are not LCOV-enforced source", () => {
    assert.ok(!out.files.includes("packages/demo/src/_router.generated.ts"));
    assert.ok(!out.files.includes("packages/demo/src/generated/schema.ts"));
  });

  assertCase(
    "only registered standalone self-tests leave source enforcement",
    () => {
      assert.ok(out.files.includes("scripts/security/tool.self-test.mjs"));
      assert.ok(
        !out.files.includes("scripts/security/coverage-gate.self-test.mjs"),
      );
      assert.ok(
        out.node_tests.includes("scripts/security/coverage-gate.self-test.mjs"),
      );
    },
  );

  assertCase(
    "registered subprocess entrypoints require tests without parent-process LCOV",
    () => {
      const entrypoint = "packages/demo/src/process-entrypoint.mjs";
      assert.ok(!out.files.includes(entrypoint));
      assert.ok(out.subprocess_files.includes(entrypoint));
    },
  );

  assertCase(
    "deleted, declaration, and type-only sources are not LCOV-enforced",
    () => {
      assert.ok(!out.files.includes("packages/demo/src/deleted.ts"));
      assert.ok(!out.files.includes("packages/demo/src/public.d.ts"));
      assert.ok(!out.files.includes("packages/demo/src/types.ts"));
    },
  );

  assertCase("runtime-equivalent source changes are not LCOV-enforced", () => {
    assert.ok(!out.files.includes("packages/demo/src/runtime-equivalent.ts"));
    assert.ok(
      out.files.includes("packages/demo/src/runtime-changed.ts"),
      `runtime change missing from changed source: ${out.files.join(",")}`,
    );
    assert.ok(
      out.files.includes("packages/demo/src/feature.ts"),
      `added runtime source missing from changed source: ${out.files.join(",")}`,
    );
  });

  assertCase("semantic comment changes remain LCOV-enforced", () => {
    assert.ok(out.files.includes("packages/demo/src/vite-directive.ts"));
    assert.ok(out.files.includes("packages/demo/src/coverage-directive.ts"));
  });

  assertCase("decorator metadata type changes remain LCOV-enforced", () => {
    assert.ok(out.files.includes("packages/demo/src/decorator-metadata.ts"));
  });

  assertCase("all executable module extensions are LCOV-enforced", () => {
    for (const extension of ["mjs", "cjs", "mts", "cts"]) {
      assert.ok(
        out.files.includes(`packages/demo/src/runtime.${extension}`),
        `${extension} runtime module missing: ${out.files.join(",")}`,
      );
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
