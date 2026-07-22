/**
 * Locks the Android device lane to the androidTest source sets actually wired
 * by Capacitor, while making every intentionally unwired native plugin an
 * explicit, reviewed exclusion.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  discoverAndroidTestModules,
  UNWIRED_ANDROID_TEST_EXCLUSIONS,
} from "../../../scripts/mobile/android-native-plugin-ci-inventory";

const repoRoot = resolve(import.meta.dir, "../../..");
const androidDir = join(repoRoot, "packages/app-core/platforms/android");
const pluginsDir = join(repoRoot, "plugins");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function normalize(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

function independentlyDeriveWiredAndroidTests(): string[] {
  const sources = [
    read("packages/app-core/platforms/android/settings.gradle"),
    read("packages/app-core/platforms/android/capacitor.settings.gradle"),
  ];
  const modules = new Set<string>();
  const projectDirs = new Map<string, string>();

  for (const source of sources) {
    for (const line of source.split("\n")) {
      if (!/^\s*include\s+/.test(line)) continue;
      for (const match of line.matchAll(/["'](:[^"']+)["']/g)) {
        modules.add(match[1]);
      }
    }
    for (const match of source.matchAll(
      /project\(\s*["'](:[^"']+)["']\s*\)\.projectDir\s*=\s*new File\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      projectDirs.set(match[1], match[2]);
    }
  }

  return [...modules]
    .filter((moduleName) => {
      const defaultDir = moduleName.split(":").filter(Boolean).join(sep);
      const projectDir = resolve(
        androidDir,
        projectDirs.get(moduleName) ?? defaultDir,
      );
      return existsSync(join(projectDir, "src/androidTest"));
    })
    .map((moduleName) => `${moduleName}:connectedDebugAndroidTest`)
    .sort();
}

function nativePluginsWithAndroidTests(): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("plugin-native-") &&
        existsSync(join(pluginsDir, entry.name, "android/src/androidTest")),
    )
    .map((entry) => `plugins/${entry.name}`)
    .sort();
}

describe("Android native-plugin CI inventory", () => {
  test("executes every wired module that owns an androidTest source set", () => {
    const expectedTasks = independentlyDeriveWiredAndroidTests();
    const inventory = discoverAndroidTestModules(androidDir);
    const actualTasks = inventory.map(({ task }) => task);

    expect(actualTasks).toEqual(expectedTasks);
    expect(actualTasks).toContain(":app:connectedDebugAndroidTest");
    expect(actualTasks.length).toBeGreaterThan(10);

    const laneSource = read("scripts/mobile/android-native-plugin-ci.sh");
    expect(laneSource).toContain(
      "scripts/mobile/android-native-plugin-ci-inventory.ts",
    );
    expect(laneSource).toMatch(/"\$\{ANDROID_TEST_TASKS\[@\]\}"/);
    expect(laneSource).not.toMatch(
      /^\s*:elizaos-capacitor-[^\s]+:connectedDebugAndroidTest/m,
    );
  });

  test("documents every androidTest plugin that Capacitor does not wire", () => {
    const wiredPluginDirs = new Set(
      discoverAndroidTestModules(androidDir)
        .map(({ projectDir }) => normalize(relative(repoRoot, projectDir)))
        .filter((projectDir) => projectDir.startsWith("plugins/plugin-native-"))
        .map((projectDir) => projectDir.replace(/\/android$/, "")),
    );
    const unwiredPluginDirs = nativePluginsWithAndroidTests().filter(
      (pluginDir) => !wiredPluginDirs.has(pluginDir),
    );
    const exclusions = Object.keys(UNWIRED_ANDROID_TEST_EXCLUSIONS).sort();

    expect(unwiredPluginDirs).toEqual(exclusions);
    expect(exclusions).toEqual(["plugins/plugin-native-network-policy"]);
    expect(
      UNWIRED_ANDROID_TEST_EXCLUSIONS["plugins/plugin-native-network-policy"],
    ).toContain("does not depend on @elizaos/capacitor-network-policy");

    const appPackage = JSON.parse(read("packages/app/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(
      appPackage.dependencies?.["@elizaos/capacitor-network-policy"],
    ).toBeUndefined();
    expect(
      read("packages/app-core/platforms/android/capacitor.settings.gradle"),
    ).not.toContain("plugin-native-network-policy/android");
  });
});
