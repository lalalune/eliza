/**
 * Guards the builtin view mutation authority: first-party pages with local
 * mutation controls must have semantic action coverage, while diagnostic views
 * stay explicitly exempt.
 *
 * The registered-action set is scanned live from source (the same
 * `registered-action-inventory` scanner the action-catalog generator and the
 * repo-level view->action audit use, #14369) unioned with the canonical
 * prompt-spec names, so a renamed/deleted action fails this test instead of
 * silently passing against a hand-maintained list — the drift class that
 * mis-filed #14365/#14366/#14367.
 *
 * The completeness sweep (#16944) walks the real pages directory, so a new
 * mutating shell page fails here until it is action-mapped or exempted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRegisteredActionInventory } from "../../../prompts/scripts/registered-action-inventory.js";
import {
  BUILTIN_VIEW_MUTATION_AUTHORITY,
  SHELL_PAGE_SWEEP_EXEMPTIONS,
  validateBuiltinViewMutationCoverage,
  validateShellPageSweepCompleteness,
} from "./builtin-view-action-ratchet";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

/** Canonical spec names cover REPLY-style actions whose `name:` is spec-derived. */
function canonicalSpecActionNames(): string[] {
  const specsDir = path.join(repoRoot, "packages/prompts/specs/actions");
  const names: string[] = [];
  for (const file of readdirSync(specsDir)) {
    if (!file.endsWith(".json")) continue;
    const spec = JSON.parse(
      readFileSync(path.join(specsDir, file), "utf8"),
    ) as { actions?: { name?: unknown }[] };
    for (const item of spec.actions ?? []) {
      if (typeof item.name === "string") names.push(item.name);
    }
  }
  return names;
}

const REGISTERED_ACTIONS = new Set([
  ...collectRegisteredActionInventory(repoRoot).map((entry) => entry.name),
  ...canonicalSpecActionNames(),
]);

function readRepoSource(sourcePath: string): string {
  return readFileSync(path.join(repoRoot, sourcePath), "utf8");
}

const PAGES_DIR = "packages/ui/src/components/pages";

/**
 * Enumerates every shell page module the completeness sweep must account for:
 * .ts/.tsx sources under the pages directory, recursive, minus tests, stories,
 * and the Playwright __e2e__ harness.
 */
function collectShellPageFiles(relDir: string = PAGES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, relDir))) {
    const rel = `${relDir}/${entry}`;
    if (statSync(path.join(repoRoot, rel)).isDirectory()) {
      if (entry === "__e2e__") continue;
      out.push(...collectShellPageFiles(rel));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|stories)\.(ts|tsx)$/.test(entry) || entry.endsWith(".d.ts")) {
      continue;
    }
    out.push(rel);
  }
  return out;
}

describe("builtin view action authority (#14369)", () => {
  it("maps current builtin views to live semantic actions or explicit exemptions", () => {
    const result = validateBuiltinViewMutationCoverage({
      readSource: readRepoSource,
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    for (const site of result.sites) {
      expect(
        site.semanticActions.length > 0 ||
          (site.exemptReason?.trim().length ?? 0) > 0,
        `${site.sourceFile}:${site.line} ${site.marker} has no semantic action or reasoned exemption`,
      ).toBe(true);
    }
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewId: "tasks",
          semanticActions: ["SCHEDULED_TASKS"],
        }),
        expect.objectContaining({
          viewId: "plugins-page",
          semanticActions: [
            "APP",
            "SETTINGS",
            "PLUGIN",
            "SECRETS",
            "RUNTIME",
            "CONNECTOR",
          ],
        }),
        expect.objectContaining({
          viewId: "memories",
          semanticActions: ["MEMORY"],
        }),
        expect.objectContaining({
          viewId: "automations",
          semanticActions: ["SCHEDULED_TASKS", "TRIGGER"],
        }),
        expect.objectContaining({
          viewId: "logs",
          exempt: true,
        }),
      ]),
    );
  });

  it("reports a mapped source that disappears", () => {
    const automations = BUILTIN_VIEW_MUTATION_AUTHORITY.find(
      (entry) => entry.viewId === "automations",
    );
    if (!automations) throw new Error("automations authority entry missing");
    const result = validateBuiltinViewMutationCoverage({
      authority: [automations],
      readSource: (sourcePath) =>
        sourcePath === automations.sourceFiles[0]
          ? null
          : readRepoSource(sourcePath),
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "automations",
        code: "missing-source",
      }),
    ]);
  });

  it("fails when a non-exempt builtin mapping references an unregistered action", () => {
    const result = validateBuiltinViewMutationCoverage({
      authority: [
        {
          viewId: "synthetic",
          sourceFiles: ["synthetic.tsx"],
          semanticActions: ["MISSING_ACTION"],
        },
      ],
      readSource: () => "<button onClick={save}>Save</button>",
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "synthetic",
        code: "missing-semantic-action",
      }),
    ]);
  });

  it.each([
    "tasks",
    "documents",
    "files",
    "memories",
    "automations",
    "triggers",
  ])(
    "rejects an injected browser-local control in mapped %s source",
    (viewId) => {
      const entry = BUILTIN_VIEW_MUTATION_AUTHORITY.find(
        (candidate) => candidate.viewId === viewId,
      );
      if (!entry) throw new Error(`${viewId} authority entry missing`);
      const injected = `${readRepoSource(entry.sourceFiles[0])}
      export function InjectedLocalOnlyButton() {
        return <button onClick={() => window.localStorage.setItem("injected", "1")}>Local only</button>;
      }
    `;
      const result = validateBuiltinViewMutationCoverage({
        authority: [entry],
        readSource: (sourcePath) =>
          sourcePath === entry.sourceFiles[0]
            ? injected
            : readRepoSource(sourcePath),
        registeredActions: REGISTERED_ACTIONS,
      });

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        expect.objectContaining({
          viewId,
          code: "unclassified-local-mutation",
        }),
      ]);
    },
  );

  it("rejects duplicate authority claims instead of overwriting an owner", () => {
    const sourceFile = "synthetic.tsx";
    const result = validateBuiltinViewMutationCoverage({
      authority: [
        {
          viewId: "first",
          sourceFiles: [sourceFile],
          semanticActions: ["SETTINGS"],
        },
        {
          viewId: "second",
          sourceFiles: [sourceFile],
          semanticActions: ["FILES"],
        },
      ],
      readSource: () => "<button onClick={save}>Save</button>",
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ code: "duplicate-source-claim" }),
    ]);
  });

  it("rejects a per-site exemption that starts absorbing multiple controls", () => {
    const sourceFile = "synthetic.tsx";
    const result = validateBuiltinViewMutationCoverage({
      authority: [
        {
          viewId: "synthetic",
          sourceFiles: [sourceFile],
          semanticActions: ["SETTINGS"],
        },
      ],
      siteExemptions: [
        {
          sourceFile,
          marker: "onClick",
          snippetIncludes: 'localStorage.setItem("local"',
          reason: "synthetic local preference",
        },
      ],
      readSource: () => `
        <button onClick={() => localStorage.setItem("local", "one")} />
        <button onClick={() => localStorage.setItem("local", "two")} />
      `,
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ code: "ambiguous-site-exemption" }),
    ]);
  });

  it("rejects blank or conflicting exemptions", () => {
    const result = validateBuiltinViewMutationCoverage({
      authority: [
        {
          viewId: "synthetic",
          sourceFiles: ["synthetic.tsx"],
          semanticActions: ["SETTINGS"],
          exemptReason: " ",
        },
      ],
      readSource: () => "<button onClick={save}>Save</button>",
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "invalid-exemption" }),
      expect.objectContaining({ code: "invalid-exemption" }),
    ]);
  });
});

describe("shell page source-completeness sweep (#16944)", () => {
  const realPageFiles = collectShellPageFiles();

  it("accounts for every real shell page module", () => {
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      readSource: readRepoSource,
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    const mutating = result.inventory.filter((row) => row.mutationSites > 0);
    for (const row of mutating) {
      expect(row.coveredBy != null || row.exempt).toBe(true);
    }
  });

  it("fails with an actionable message when an unlisted mutating page ships", () => {
    const syntheticPage = `${PAGES_DIR}/BrandNewLocalOnlyView.tsx`;
    const result = validateShellPageSweepCompleteness({
      pageFiles: [...realPageFiles, syntheticPage],
      readSource: (sourcePath) =>
        sourcePath === syntheticPage
          ? '<button onClick={() => window.localStorage.setItem("x", "1")}>Local only</button>'
          : readRepoSource(sourcePath),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: syntheticPage,
        code: "unmapped-mutating-page",
        message: expect.stringContaining("BUILTIN_VIEW_MUTATION_AUTHORITY"),
      }),
    ]);
  });

  it("fails when an exemption points at a file the sweep no longer sees", () => {
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      exemptions: [
        ...SHELL_PAGE_SWEEP_EXEMPTIONS,
        { sourceFile: `${PAGES_DIR}/DeletedView.tsx`, reason: "gone" },
      ],
      readSource: readRepoSource,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: `${PAGES_DIR}/DeletedView.tsx`,
        code: "stale-exemption",
      }),
    ]);
  });

  it("fails when an exempt file stops mutating (exemption must be removed)", () => {
    const exemptFile = SHELL_PAGE_SWEEP_EXEMPTIONS[0].sourceFile;
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      readSource: (sourcePath) =>
        sourcePath === exemptFile
          ? "export const nowInert = true;"
          : readRepoSource(sourcePath),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: exemptFile,
        code: "stale-exemption",
      }),
    ]);
  });

  it("fails when a file is both authority-covered and exempt", () => {
    const covered = "packages/ui/src/components/pages/FilesView.tsx";
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      exemptions: [
        ...SHELL_PAGE_SWEEP_EXEMPTIONS,
        { sourceFile: covered, reason: "double-booked" },
      ],
      readSource: readRepoSource,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: covered,
        code: "conflicting-exemption",
      }),
    ]);
  });

  it("fails when two authority entries claim the same page", () => {
    const sourceFile = `${PAGES_DIR}/DuplicateClaim.tsx`;
    const result = validateShellPageSweepCompleteness({
      pageFiles: [sourceFile],
      authority: [
        {
          viewId: "first",
          sourceFiles: [sourceFile],
          semanticActions: ["SETTINGS"],
        },
        {
          viewId: "second",
          sourceFiles: [sourceFile],
          semanticActions: ["FILES"],
        },
      ],
      exemptions: [],
      readSource: () => "<button onClick={save}>Save</button>",
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ code: "duplicate-authority-claim" }),
    ]);
  });
});
