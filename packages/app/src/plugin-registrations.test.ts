/**
 * Pins `discoverSideEffectAppModules` against the real plugin/package tree:
 * every plugin that self-declares `elizaos.appRegister` must be discovered in a
 * stable order, resolve a real entry file, and be a `workspace:*` dependency of
 * this app — and the first-render `/register` module must still be imported by
 * main.tsx. Reads the live filesystem (no mocks).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSideEffectAppModules } from "../vite/app-side-effect-modules.ts";

// The renderer side-effect app-module list is no longer hardcoded in the app
// shell — each app plugin self-declares `elizaos.appRegister` in its own
// package.json and the renderer build scans for it. This test pins the scan's
// result against the real plugin tree so a regression (a dropped marker, a moved
// entry file, a plugin added without a workspace dep) fails loudly.

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SCAN_ROOTS = [
  resolve(REPO_ROOT, "plugins"),
  resolve(REPO_ROOT, "packages"),
];

// Loader cache keys expected from the manifest scan. `register`-mode plugins
// carry a `/register` suffix so the side-effect module can never collide in
// the shared dynamic-import cache with a bare import of the same package
// (which resolves to the package's browser/ui entry, a different module).
const EXPECTED_SIDE_EFFECT_PACKAGES = [
  "@elizaos/app-model-tester",
  "@elizaos/plugin-contacts/register",
  "@elizaos/plugin-facewear/register",
  "@elizaos/plugin-feed/register",
  "@elizaos/plugin-hyperliquid/register",
  "@elizaos/plugin-native-settings/register",
  "@elizaos/plugin-phone/register",
  "@elizaos/plugin-polymarket/register",
  "@elizaos/plugin-trajectory-logger/register",
  "@elizaos/plugin-vector-browser/register",
  "@elizaos/plugin-wallet-ui/register",
  "@elizaos/plugin-wifi/register",
] as const;

// Imported directly by the app shell (main.tsx), not via the manifest scan.
const FIRST_RENDER_REGISTRATION_MODULES = [
  "@elizaos/plugin-task-coordinator/register",
] as const;

describe("side-effect app module registration (manifest-driven)", () => {
  it("discovers every plugin that self-declares elizaos.appRegister", () => {
    const discovered = discoverSideEffectAppModules(SCAN_ROOTS);
    expect(discovered.map((m) => m.key)).toEqual([
      ...EXPECTED_SIDE_EFFECT_PACKAGES,
    ]);
  });

  it("resolves a real entry file for every discovered module", () => {
    for (const module of discoverSideEffectAppModules(SCAN_ROOTS)) {
      expect(() => readFileSync(module.entry, "utf8")).not.toThrow();
    }
  });

  it("declares each discovered module as a workspace dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    for (const module of discoverSideEffectAppModules(SCAN_ROOTS)) {
      const packageName = module.key.replace(/\/register$/, "");
      expect(packageJson.dependencies?.[packageName]).toBe("workspace:*");
    }
  });

  it("loads chat inline-widget registrations before first render", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "main.tsx"),
      "utf8",
    );

    for (const moduleId of FIRST_RENDER_REGISTRATION_MODULES) {
      expect(source).toContain(`import("${moduleId}")`);
    }
  });
});
