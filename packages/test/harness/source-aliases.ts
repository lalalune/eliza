/**
 * Shared Vitest source-alias builder for `withMockLlmRuntime()` consumers.
 *
 * Booting a real PGLite-backed AgentRuntime requires every workspace
 * `@elizaos/*` package to resolve to its TypeScript source (independent of
 * build order), plus the three subpath specials the runtime touches:
 * `@elizaos/core/testing`, `@elizaos/core/node`, and `@elizaos/plugin-sql`
 * (the node entry). The harness's own `vitest.config.ts` needs this, and so
 * does every per-plugin harness config that imports `@elizaos/test-harness`.
 * Both consume this one builder so the alias set never drifts.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Vite rollup alias shape (structural to avoid duplicate vite typings). */
export interface SourceAlias {
  find: RegExp;
  replacement: string;
}

/** The elizaOS monorepo root (three levels up from `packages/test/harness`). */
export const harnessRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

interface WorkspaceSourceEntry {
  packageName: string;
  indexPath: string;
  sourceDir: string;
  exportedSubpaths: SourceAlias[];
  exportedSubpathNames: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveConditionalTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const conditions = value as Record<string, unknown>;
  for (const condition of ["node", "import", "default", "browser", "types"]) {
    const target = resolveConditionalTarget(conditions[condition]);
    if (target) return target;
  }
  return undefined;
}

const SOURCE_SCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

function expandScriptOutputPath(targetPath: string): string[] {
  const declarationMatch = targetPath.match(/[.]d[.](?:ts|mts|cts)$/);
  if (declarationMatch) {
    const stem = targetPath.slice(0, -declarationMatch[0].length);
    return SOURCE_SCRIPT_EXTENSIONS.map((extension) => `${stem}${extension}`);
  }
  const extension = path.extname(targetPath);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = targetPath.slice(0, -extension.length);
    return SOURCE_SCRIPT_EXTENSIONS.map(
      (sourceExtension) => `${stem}${sourceExtension}`,
    );
  }
  return [targetPath];
}

function findContainedSourceFile(
  packageDir: string,
  candidates: string[],
): string | undefined {
  const realPackageDir = realpathSync(packageDir);
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    try {
      const realCandidate = realpathSync(candidate);
      const relative = path.relative(realPackageDir, realCandidate);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !statSync(realCandidate).isFile()
      ) {
        continue;
      }
      const normalizedRelative = relative.split(path.sep).join("/");
      if (
        normalizedRelative === "dist" ||
        normalizedRelative.startsWith("dist/")
      ) {
        continue;
      }
      return realCandidate;
    } catch {
      // error-policy:J3 A manifest target can disappear between discovery and resolution.
    }
  }
  return undefined;
}

function getTargetSourceCandidates(
  packageDir: string,
  target: string,
): string[] {
  if (!target.startsWith("./") || target.includes("*")) return [];
  const normalized = target.slice(2).split("/").join(path.sep);
  const sourceRelative = normalized.startsWith(`dist${path.sep}`)
    ? path.join("src", normalized.slice(`dist${path.sep}`.length))
    : normalized;
  return expandScriptOutputPath(path.resolve(packageDir, sourceRelative));
}

function getSubpathSourceCandidates(
  sourceDir: string,
  subpath: string,
): string[] {
  const relativeSubpath = subpath.slice(2).split("/").join(path.sep);
  const basePath = path.resolve(sourceDir, relativeSubpath);
  const candidates = [
    basePath,
    ...SOURCE_SCRIPT_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...SOURCE_SCRIPT_EXTENSIONS.map((extension) =>
      path.join(basePath, `index${extension}`),
    ),
  ];
  if (!relativeSubpath.includes(path.sep)) {
    candidates.push(
      ...SOURCE_SCRIPT_EXTENSIONS.map((extension) =>
        path.join(sourceDir, `index.${relativeSubpath}${extension}`),
      ),
    );
  }
  return candidates;
}

interface ExportedSourceSubpaths {
  aliases: SourceAlias[];
  names: string[];
}

function getExportedSourceSubpaths(
  packageDir: string,
  packageName: string,
  sourceDir: string,
  exports: unknown,
): ExportedSourceSubpaths {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    return { aliases: [], names: [] };
  }

  const entries = Object.entries(exports as Record<string, unknown>).filter(
    ([subpath]) =>
      subpath !== "." && subpath.startsWith("./") && !subpath.includes("*"),
  );
  const aliases = entries.flatMap(([subpath, value]) => {
    const conditionalValue =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const targets = [
      resolveConditionalTarget(
        conditionalValue?.["eliza-source"] ?? conditionalValue?.bun,
      ),
      resolveConditionalTarget(value),
    ].filter((target): target is string => target !== undefined);
    const replacement = findContainedSourceFile(packageDir, [
      ...targets.flatMap((target) =>
        getTargetSourceCandidates(packageDir, target),
      ),
      ...getSubpathSourceCandidates(sourceDir, subpath),
    ]);
    if (!replacement) return [];
    const importPath = `${packageName}/${subpath.slice(2)}`;
    return [
      {
        find: new RegExp(`^${escapeRegExp(importPath)}$`),
        replacement,
      },
    ];
  });
  return {
    aliases,
    names: entries.map(([subpath]) => subpath.slice(2)),
  };
}

function getWorkspaceSourceEntry(
  packageDir: string,
): WorkspaceSourceEntry | undefined {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    exports?: unknown;
  };
  if (!packageJson.name?.startsWith("@elizaos/")) return undefined;
  // The harness itself resolves via its package.json exports.
  if (packageJson.name === "@elizaos/test-harness") return undefined;
  const sourceIndex = path.join(packageDir, "src", "index.ts");
  let indexPath: string;
  let sourceDir: string;
  if (existsSync(sourceIndex)) {
    indexPath = sourceIndex;
    sourceDir = path.join(packageDir, "src");
  } else {
    const rootIndex = path.join(packageDir, "index.ts");
    if (!existsSync(rootIndex)) return undefined;
    indexPath = rootIndex;
    sourceDir = packageDir;
  }
  const exported = getExportedSourceSubpaths(
    packageDir,
    packageJson.name,
    sourceDir,
    packageJson.exports,
  );
  return {
    packageName: packageJson.name,
    indexPath,
    sourceDir,
    exportedSubpaths: exported.aliases,
    exportedSubpathNames: exported.names,
  };
}

/**
 * Directory names that never contain workspace packages — pruned from the
 * recursive descent so we don't walk into installed deps or build output.
 */
const PRUNE_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".git",
  "coverage",
]);

/**
 * Collect every workspace package dir under `root`, descending through
 * grouping directories that are not themselves packages.
 *
 * The eliza monorepo nests published `@elizaos/*` packages several levels deep
 * (e.g. `@elizaos/cloud-routing` at `packages/cloud/routing`, gateways at
 * `packages/cloud/services/*`). A flat `readdirSync(packages)` misses those, so
 * their harness source alias is never emitted and Vite falls back to the
 * package `exports` -> `dist/index.js`, which does not exist under the keyless
 * `--ignore-scripts` install. That surfaces as
 * `Failed to resolve entry for package "@elizaos/cloud-routing"` in every
 * per-plugin harness proof (core re-exports the cloud routing surface).
 *
 * Descend recursively but stop at the first directory that IS a package (a
 * package's own subdirs are not separate workspace packages), and prune known
 * non-source dirs. `maxDepth` bounds the walk defensively.
 */
function collectWorkspacePackageDirs(root: string, maxDepth = 4): string[] {
  if (!existsSync(root) || maxDepth < 0) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (PRUNE_DIRS.has(name)) continue;
    const child = path.join(root, name);
    let isDir = false;
    try {
      isDir = statSync(child).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    if (existsSync(path.join(child, "package.json"))) {
      // A package dir: record it and do not descend (its subdirs belong to it).
      out.push(child);
    } else {
      // A grouping dir: keep descending to find nested packages.
      out.push(...collectWorkspacePackageDirs(child, maxDepth - 1));
    }
  }
  return out;
}

function buildExactExportExclusion(exportedSubpathNames: string[]): string {
  if (exportedSubpathNames.length === 0) return "";
  const alternatives = exportedSubpathNames.map(escapeRegExp).join("|");
  return `(?!(?:${alternatives})$)`;
}

/**
 * Build the full alias list for a harness consumer. Explicit entries
 * (`@elizaos/core/testing`, `@elizaos/core/node`, `@elizaos/plugin-sql`) are
 * placed first so they win over the generic per-package rules (Vite is
 * first-match).
 */
export function buildHarnessSourceAliases(
  repoRoot: string = harnessRepoRoot,
): SourceAlias[] {
  const workspaceDirs = [
    path.join(repoRoot, "plugins"),
    path.join(repoRoot, "packages"),
  ];

  const workspaceSourceAliases = workspaceDirs.flatMap((dir) =>
    existsSync(dir)
      ? collectWorkspacePackageDirs(dir)
          .map((packageDir) => getWorkspaceSourceEntry(packageDir))
          .filter((entry): entry is WorkspaceSourceEntry => entry !== undefined)
          .flatMap((entry) => {
            const {
              packageName,
              indexPath,
              sourceDir,
              exportedSubpaths,
              exportedSubpathNames,
            } = entry;
            const packagePattern = escapeRegExp(packageName);
            const exactExportExclusion =
              buildExactExportExclusion(exportedSubpathNames);
            return [
              {
                find: new RegExp(`^${packagePattern}$`),
                replacement: indexPath,
              },
              // Exact public subpaths can target directory indexes, platform
              // entrypoints, or JSON outside `src`. Honor package exports before
              // the generic source fallback so those imports never become a
              // fabricated path.
              ...exportedSubpaths,
              // Asset subpaths (JSON data imports like
              // `@elizaos/registry/first-party/curated-app-definitions.json`)
              // resolve to the source file as-is. Exact public exports are
              // excluded from both fallbacks so an unresolved manifest target
              // reaches package resolution instead of a made-up source path.
              {
                find: new RegExp(
                  `^${packagePattern}/${exactExportExclusion}(.*\\.json)$`,
                ),
                replacement: path.join(sourceDir, "$1"),
              },
              {
                find: new RegExp(
                  `^${packagePattern}/${exactExportExclusion}(.*)$`,
                ),
                // Vite resolves TypeScript extensions and directory indexes
                // after alias substitution; forcing `.ts` breaks index barrels.
                replacement: path.join(sourceDir, "$1"),
              },
            ];
          })
      : [],
  );

  return [
    {
      find: /^@elizaos\/core\/testing$/,
      replacement: path.join(repoRoot, "packages/core/src/testing/index.ts"),
    },
    {
      find: /^@elizaos\/core\/node$/,
      replacement: path.join(repoRoot, "packages/core/src/index.node.ts"),
    },
    {
      find: /^@elizaos\/plugin-sql$/,
      replacement: path.join(repoRoot, "plugins/plugin-sql/src/index.node.ts"),
    },
    ...workspaceSourceAliases,
  ];
}
