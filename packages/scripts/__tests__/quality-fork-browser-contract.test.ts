import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../quality-fork-browser-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const VALID_WORKFLOW = `name: Quality (Fork)
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: Install homepage browser
        working-directory: packages/homepage
        run: ./node_modules/.bin/playwright install chromium

      - name: Test homepage downloads
        working-directory: packages/homepage
        run: bun run test:e2e
`;

function buildRepo(workflow = VALID_WORKFLOW) {
  const root = mkdtempSync(join(tmpdir(), "quality-fork-browser-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "quality-fork.yml"),
    workflow,
  );
  return root;
}

describe("quality-fork-browser-contract", () => {
  test("rejects persistent runners for fork-authored code", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace(
        "runs-on: ubuntu-24.04",
        "runs-on: [self-hosted, hetzner-robot]",
      ),
    );
    try {
      expect(() => runContract(root)).toThrow(
        /every job must run on ubuntu-24\.04/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts unprivileged Chromium install followed by the real browser test", () => {
    const root = buildRepo();
    try {
      expect(runContract(root)).toEqual({
        workflow: ".github/workflows/quality-fork.yml",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects Playwright dependency installation that invokes sudo", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace(
        "install chromium",
        "install --with-deps chromium",
      ),
    );
    try {
      expect(() => runContract(root)).toThrow(/without privileged dependency/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects removal of the real homepage browser test", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace("bun run test:e2e", "echo browser-test-skipped"),
    );
    try {
      expect(() => runContract(root)).toThrow(
        /real homepage browser test must remain enabled/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds only the measured mobile visual renderer variance", () => {
    const config = readFileSync(
      join(REAL_REPO_ROOT, "packages", "homepage", "playwright.config.ts"),
      "utf8",
    );
    const visual = readFileSync(
      join(
        REAL_REPO_ROOT,
        "packages",
        "homepage",
        "tests",
        "e2e",
        "visual.spec.ts",
      ),
      "utf8",
    );
    expect(config).toMatch(/maxDiffPixelRatio:\s*0\.05/);
    expect(visual).toMatch(
      /maxDiffPixelRatio:\s*viewport\.name === ["']mobile["'] \? 0\.08 : 0\.05/,
    );
  });

  test("the checked-in Quality (Fork) workflow satisfies the contract", () => {
    expect(runContract(REAL_REPO_ROOT)).toEqual({
      workflow: ".github/workflows/quality-fork.yml",
    });
    const workflow = readFileSync(
      join(REAL_REPO_ROOT, ".github", "workflows", "quality-fork.yml"),
      "utf8",
    );
    expect(workflow.match(/^ {4}runs-on: ubuntu-24\.04$/gm)).toHaveLength(4);
    expect(workflow).not.toMatch(
      /self-hosted|hetzner-robot|HETZNER_FLEET_ONLINE/,
    );
  });
});
