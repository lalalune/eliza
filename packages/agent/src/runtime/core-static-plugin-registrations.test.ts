/**
 * Drift guard for the CORE_STATIC_PLUGIN_REGISTRATIONS descriptor table
 * (#12089 item 3). The descriptor table in eliza.ts used to be a SECOND parallel
 * registry hand-mirroring the bundle-manifest lists: adding an optional plugin
 * to OPTIONAL_STATIC_PLUGIN_PACKAGES (bundleability) without also hand-adding a
 * descriptor row (registration) — or vice versa — drifted silently, leaving a
 * plugin either non-bundleable or bundled-but-never-registered. The blocking
 * pair likewise hand-mirrored BLOCKING_CORE_PLUGINS.
 *
 * The table is now DERIVED:
 *   - deferred rows  <- OPTIONAL_STATIC_PLUGIN_REGISTRATIONS minus the blocking set
 *   - blocking rows  <- BLOCKING_CORE_PLUGINS (+ declared bespoke loaders)
 *
 * These tests assert the derivation wiring holds and that the old hand-written
 * object-literal rows are gone from the executable path, so the two lists can no
 * longer diverge without a test failure.
 *
 * eliza.ts is read as TEXT (not imported) so vitest never eagerly resolves the
 * heavy runtime module and its transitive optional-plugin specifiers — the same
 * technique optional-plugins.test.ts and eliza-local-agent-port-gate.test.ts use.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BLOCKING_CORE_PLUGINS } from "./core-plugins.ts";
import {
  OPTIONAL_STATIC_PLUGIN_OVERRIDES,
  OPTIONAL_STATIC_PLUGIN_PACKAGES,
  OPTIONAL_STATIC_PLUGIN_REGISTRATIONS,
  UNBUNDLED_OPTIONAL_PLUGINS,
} from "./optional-plugins.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function elizaSource(): string {
  return readFileSync(path.join(here, "eliza.ts"), "utf8");
}

describe("optional static-plugin source of truth", () => {
  it("OPTIONAL_STATIC_PLUGIN_REGISTRATIONS = bundled ++ unbundled, in order", () => {
    // One list feeds both the mobile-bundle importer codegen (bundled subset)
    // and the runtime descriptor table (whole list). If they ever came from two
    // hand-written lists again, this composition is the seam that would drift.
    expect(OPTIONAL_STATIC_PLUGIN_REGISTRATIONS).toEqual([
      ...OPTIONAL_STATIC_PLUGIN_PACKAGES,
      ...UNBUNDLED_OPTIONAL_PLUGINS,
    ]);
  });

  it("has no duplicate package entries", () => {
    expect(new Set(OPTIONAL_STATIC_PLUGIN_REGISTRATIONS).size).toBe(
      OPTIONAL_STATIC_PLUGIN_REGISTRATIONS.length,
    );
  });

  it("every declared override annotates a real optional plugin", () => {
    // A stale override (typo'd or removed package) would silently apply to
    // nothing; keep overrides pinned to the list they annotate.
    const known = new Set(OPTIONAL_STATIC_PLUGIN_REGISTRATIONS);
    for (const pkg of Object.keys(OPTIONAL_STATIC_PLUGIN_OVERRIDES)) {
      expect(known.has(pkg), `override for unlisted plugin ${pkg}`).toBe(true);
    }
  });

  it("agent-orchestrator declares its short-name registry key via override", () => {
    // Regression: the orchestrator registers/looks-up as "agent-orchestrator",
    // not its package name. That must live in the declared override, not a
    // hand-written descriptor row.
    expect(
      OPTIONAL_STATIC_PLUGIN_OVERRIDES["@elizaos/plugin-agent-orchestrator"]
        ?.registryName,
    ).toBe("agent-orchestrator");
  });

  it("gitpathologist declares its mobile-skip via override, not a bespoke row", () => {
    expect(
      OPTIONAL_STATIC_PLUGIN_OVERRIDES["@elizaos/plugin-gitpathologist"]
        ?.skipOnMobile,
    ).toBe(true);
  });
});

describe("descriptor table derivation (eliza.ts source guard, #12089 item 3)", () => {
  it('declares no inline `packageName: "@elizaos/plugin-..."` object-literal rows', () => {
    // The old CORE_STATIC_PLUGIN_REGISTRATIONS was ~18 hand-written object
    // literals of this exact shape — the parallel list #12089 item 3 flagged.
    // The bespoke blocking loaders use a different shape
    // (`"@elizaos/plugin-sql": { required: ... }`), so this guard fires only if
    // someone reintroduces a hand-written descriptor row.
    const inlineRows = [
      ...elizaSource().matchAll(/packageName:\s*"@elizaos\/plugin-[^"]+"/g),
    ];
    expect(
      inlineRows.length,
      `found ${inlineRows.length} hand-written descriptor row(s); derive from OPTIONAL_STATIC_PLUGIN_REGISTRATIONS / BLOCKING_CORE_PLUGINS instead`,
    ).toBe(0);
  });

  it("builds the descriptor table from the derivation helpers", () => {
    const source = elizaSource();
    expect(source).toContain("...buildBlockingStaticRegistrations()");
    expect(source).toContain("...buildDeferredStaticRegistrations()");
  });

  it("derives deferred rows from optional registrations minus blocking plugins", () => {
    // Bundleability remains one list; the phase partition excludes entries
    // whose durable boot contracts promote them into the blocking set.
    const source = elizaSource();
    expect(source).toContain("OPTIONAL_STATIC_PLUGIN_REGISTRATIONS.filter(");
    expect(source).toContain("!BLOCKING_CORE_PLUGINS.includes(packageName)");
    expect(source).toMatch(/\.map\(\(packageName\) => \{/);
    expect(source).toContain("OPTIONAL_STATIC_PLUGIN_OVERRIDES");
  });

  it("derives blocking rows from BLOCKING_CORE_PLUGINS and fails loud on a missing loader", () => {
    const source = elizaSource();
    expect(source).toMatch(/BLOCKING_CORE_PLUGINS\.map\(\(packageName\)/);
    // The fail-loud guard is what turns a blocking-set drift (a plugin declared
    // blocking with no bespoke loader) into a hard boot error instead of a
    // silent non-registration.
    expect(source).toContain(
      "no blocking static loader is declared for it in eliza.ts",
    );
  });

  it("declares a blocking loader for every BLOCKING_CORE_PLUGINS entry", () => {
    // Text-assert the loader map covers the blocking set so the fail-loud guard
    // never actually trips at boot on the current lists. Scope the scan to the
    // BLOCKING_STATIC_PLUGIN_LOADERS object so a stray package mention elsewhere
    // can't satisfy the check. Formatting-tolerant: biome may wrap a loader
    // entry onto multiple lines, so match `"pkg": {` (a map key), not the full
    // one-line shape.
    const source = elizaSource();
    const loaderBlock = source.slice(
      source.indexOf("const BLOCKING_STATIC_PLUGIN_LOADERS"),
      source.indexOf("function buildBlockingStaticRegistrations"),
    );
    expect(
      loaderBlock.length,
      "could not locate the BLOCKING_STATIC_PLUGIN_LOADERS block in eliza.ts",
    ).toBeGreaterThan(0);
    for (const pkg of BLOCKING_CORE_PLUGINS) {
      expect(
        loaderBlock.includes(`"${pkg}": {`),
        `BLOCKING_STATIC_PLUGIN_LOADERS is missing a bespoke loader for ${pkg}`,
      ).toBe(true);
    }
  });
});
