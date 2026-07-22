/**
 * Resolves every Android Gradle module whose synced project contains
 * instrumented tests. The emulator lane consumes this inventory directly so
 * adding a wired Capacitor plugin cannot silently leave its androidTest suite
 * outside CI.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface AndroidTestModule {
  moduleName: string;
  projectDir: string;
  task: string;
}

export const UNWIRED_ANDROID_TEST_EXCLUSIONS = {
  "plugins/plugin-native-network-policy":
    "The app does not depend on @elizaos/capacitor-network-policy, so Capacitor sync does not wire its Android module into this Gradle build.",
} as const;

function includedModules(source: string): string[] {
  const modules: string[] = [];
  for (const line of source.split("\n")) {
    if (!/^\s*include\s+/.test(line)) continue;
    for (const match of line.matchAll(/["'](:[^"']+)["']/g)) {
      modules.push(match[1]);
    }
  }
  return modules;
}

function projectDirectoryOverrides(source: string): Map<string, string> {
  const overrides = new Map<string, string>();
  const pattern =
    /project\(\s*["'](:[^"']+)["']\s*\)\.projectDir\s*=\s*new File\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    overrides.set(match[1], match[2]);
  }
  return overrides;
}

export function discoverAndroidTestModules(
  androidDir: string,
): AndroidTestModule[] {
  const settingsSources = ["settings.gradle", "capacitor.settings.gradle"].map(
    (name) => readFileSync(join(androidDir, name), "utf8"),
  );
  const modules = new Set(settingsSources.flatMap(includedModules));
  const overrides = new Map<string, string>();
  for (const source of settingsSources) {
    for (const [moduleName, projectDir] of projectDirectoryOverrides(source)) {
      overrides.set(moduleName, projectDir);
    }
  }

  return [...modules]
    .map((moduleName): AndroidTestModule => {
      const defaultProjectDir = moduleName.split(":").filter(Boolean).join(sep);
      const projectDir = resolve(
        androidDir,
        overrides.get(moduleName) ?? defaultProjectDir,
      );
      return {
        moduleName,
        projectDir,
        task: `${moduleName}:connectedDebugAndroidTest`,
      };
    })
    .filter(({ projectDir }) => existsSync(join(projectDir, "src/androidTest")))
    .sort((left, right) => left.task.localeCompare(right.task));
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, "../..");
  const androidDirFlag = process.argv.indexOf("--android-dir");
  const androidDir =
    androidDirFlag === -1
      ? join(repoRoot, "packages/app-core/platforms/android")
      : process.argv[androidDirFlag + 1];
  if (!androidDir) {
    throw new Error("--android-dir requires a path");
  }

  const modules = discoverAndroidTestModules(resolve(androidDir));
  if (modules.length === 0) {
    throw new Error(`No wired androidTest modules found under ${androidDir}`);
  }
  process.stdout.write(`${modules.map(({ task }) => task).join("\n")}\n`);
}

if (import.meta.main) {
  main();
}
