/**
 * Keeps agent tests on workspace plugin source while resolving third-party
 * dependencies through Bun's real package graph instead of plugin-local
 * symlink paths that hide transitive dependencies from Vite.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const orchestratorRequire = createRequire(
  path.join(repoRoot, "plugins/plugin-agent-orchestrator/package.json"),
);

export const workspacePluginSourcePattern =
  /\/plugins\/plugin-[^/]+\/(?!node_modules\/)/;

export function resolveOrchestratorTestDependency(
  specifier: "@octokit/core" | "@octokit/rest",
): string {
  return realpathSync(orchestratorRequire.resolve(specifier));
}
