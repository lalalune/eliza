/**
 * Unit tests for the `eliza plugins` CLI input helpers: `normalizePluginName`,
 * `parsePluginSpec`, and the `validatePluginPath` boundary guard. Exercises
 * shorthand expansion, version parsing, and rejection of path-escape and
 * symlink-escape attempts against real temp-dir cwd/home fixtures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({
  installPlugin: vi.fn(),
  manager: {
    getRegistryPlugin: vi.fn(),
    listInstalledPlugins: vi.fn(),
    refreshRegistry: vi.fn(),
    searchRegistry: vi.fn(),
    uninstallPlugin: vi.fn(),
  },
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    PluginManagerService: function PluginManagerService() {
      return cli.manager;
    },
  };
});
vi.mock("@elizaos/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/agent")>();
  return { ...actual, isPluginManagerLike: () => true };
});
vi.mock("@elizaos/plugin-registry", () => ({
  installPlugin: cli.installPlugin,
}));

import {
  findPluginExport,
  normalizePluginName,
  parsePluginSpec,
  registerPluginsCli,
  validatePluginPath,
} from "./plugins-cli";

const tempDirs: string[] = [];
let originalCwd: string;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-core-plugins-cli-"));
  tempDirs.push(dir);
  return dir;
}

async function runCli(...args: string[]): Promise<void> {
  const program = new Command();
  program.name("eliza").exitOverride();
  registerPluginsCli(program);
  await program.parseAsync(["node", "eliza", ...args]);
}

describe("plugins CLI helpers", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    vi.clearAllMocks();
    cli.manager.listInstalledPlugins.mockResolvedValue([
      { name: "@elizaos/plugin-alpha", version: "1.2.3" },
    ]);
    cli.manager.searchRegistry.mockResolvedValue([]);
    cli.manager.refreshRegistry.mockResolvedValue(new Map());
    cli.manager.getRegistryPlugin.mockResolvedValue(null);
    cli.manager.uninstallPlugin.mockResolvedValue({
      success: true,
      pluginName: "@elizaos/plugin-alpha",
      requiresRestart: false,
    });
    cli.installPlugin.mockResolvedValue({
      success: true,
      pluginName: "@elizaos/plugin-alpha",
      version: "2.0.0",
      requiresRestart: true,
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs browse, detail, install, and lifecycle commands through Commander", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const searchResult = {
      name: "@elizaos/plugin-alpha",
      latestVersion: "2.0.0",
      description: "Alpha connector",
      tags: ["chat", "connector"],
      supports: { v0: false, v1: true, v2: true },
      score: 0.93,
      stars: 42,
    };
    cli.manager.searchRegistry.mockResolvedValue([searchResult]);
    cli.manager.refreshRegistry.mockResolvedValue(
      new Map([[searchResult.name, searchResult]]),
    );
    cli.manager.getRegistryPlugin.mockResolvedValue({
      ...searchResult,
      gitRepo: "elizaOS/plugin-alpha",
      homepage: "https://alpha.example",
      language: "TypeScript",
      topics: ["chat"],
      npm: {
        v0Version: null,
        v1Version: "1.9.0",
        v2Version: "2.0.0",
      },
    });

    await runCli("plugins", "list", "--query", "alpha", "--limit", "5");
    await runCli("plugins", "list", "--limit", "5");
    await runCli("plugins", "search", "alpha", "--limit", "5");
    await runCli("plugins", "info", "alpha");
    await runCli("plugins", "install", "alpha@2.0.0", "--no-restart");
    await runCli("plugins", "uninstall", "alpha", "--no-restart");
    await runCli("plugins", "installed");
    await runCli("plugins", "refresh");

    expect(cli.manager.searchRegistry).toHaveBeenCalledWith("alpha", 5);
    expect(cli.manager.getRegistryPlugin).toHaveBeenCalledWith(
      "@elizaos/plugin-alpha",
    );
    expect(cli.installPlugin).toHaveBeenCalledWith(
      "@elizaos/plugin-alpha",
      expect.any(Function),
      "2.0.0",
    );
    expect(cli.manager.uninstallPlugin).toHaveBeenCalledWith("alpha");
    expect(log.mock.calls.flat().join("\n")).toContain("Alpha connector");
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("renders plugin configuration values while masking secrets", async () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, "plugins.json"),
      JSON.stringify({
        plugins: [
          {
            id: "plugin-alpha",
            name: "Alpha",
            pluginParameters: {
              ALPHA_TOKEN: {
                type: "string",
                description: "API token",
                required: true,
                sensitive: true,
              },
              ALPHA_REGION: {
                type: "string",
                description: "Region",
              },
            },
            configUiHints: {
              ALPHA_TOKEN: { label: "Alpha token", sensitive: true },
            },
          },
        ],
      }),
    );
    process.chdir(root);
    vi.stubEnv("ALPHA_TOKEN", "top-secret");
    vi.stubEnv("ALPHA_REGION", "us-east-1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli("plugins", "config", "plugin-alpha");

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Alpha token");
    expect(output).toContain("●●●●●●●●");
    expect(output).not.toContain("top-secret");
    expect(output).toContain("us-east-1");
  });

  it("finds strict plugin exports before basic metadata lookalikes", () => {
    const strict = {
      name: "Strict",
      description: "Has runtime capabilities",
      actions: [],
    };
    const basic = { name: "Basic", description: "Metadata only" };

    expect(findPluginExport({ default: strict, plugin: basic })).toBe(strict);
    expect(findPluginExport({ pluginAlpha: strict, fallback: basic })).toBe(
      strict,
    );
    expect(findPluginExport({ pluginAlpha: basic })).toBe(basic);
    expect(findPluginExport({ default: basic })).toBe(basic);
    expect(findPluginExport({ value: 42 })).toBeNull();
  });

  it("surfaces empty, missing, and failed plugin operations", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    cli.manager.listInstalledPlugins.mockResolvedValue([]);
    cli.manager.searchRegistry.mockResolvedValue([]);
    cli.manager.getRegistryPlugin.mockResolvedValue(null);
    cli.installPlugin.mockResolvedValue({
      success: false,
      error: "registry unavailable",
    });
    cli.manager.uninstallPlugin.mockResolvedValue({
      success: false,
      error: "plugin is built in",
    });

    await runCli("plugins", "list", "--query", "missing");
    await runCli("plugins", "info", "missing");
    await runCli("plugins", "installed");
    await runCli("plugins", "install", "missing", "--no-restart");
    await runCli("plugins", "uninstall", "missing", "--no-restart");
    await runCli("plugins", "install", "../invalid", "--no-restart");

    const root = makeTempDir();
    process.chdir(root);
    await runCli("plugins", "add-path", path.join(root, "not-created"));

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain('No plugins found matching "missing"');
    expect(output).toContain("No plugins installed");
    expect(output).toContain("registry unavailable");
    expect(output).toContain("plugin is built in");
    expect(output).toContain("is not a directory");
    expect(error.mock.calls.flat().join("\n")).toContain("Invalid plugin name");
    expect(process.exitCode).toBe(1);
  });

  it("normalizes shorthand plugin names and rejects empty names", () => {
    expect(normalizePluginName("discord")).toBe("@elizaos/plugin-discord");
    expect(normalizePluginName(" plugin-browser ")).toBe("plugin-browser");
    expect(normalizePluginName("@scope/plugin-foo")).toBe("@scope/plugin-foo");
    expect(() => normalizePluginName("   ")).toThrow("Plugin name is required");
  });

  it("rejects path-like and whitespace-bearing plugin names before install", () => {
    for (const name of [
      "../plugin-evil",
      "@scope/../plugin-evil",
      "plugin-evil/path",
      "plugin-evil\\path",
      "plugin evil",
      "plugin-evil\nnext",
    ]) {
      expect(() => normalizePluginName(name)).toThrow("Invalid plugin name");
    }
  });

  it("parses plugin specs with optional versions", () => {
    expect(() => parsePluginSpec("   ")).toThrow("Plugin name is required");
    expect(parsePluginSpec("discord@1.2.3")).toEqual({
      name: "@elizaos/plugin-discord",
      version: "1.2.3",
    });
    expect(parsePluginSpec("@scope/plugin-foo@next")).toEqual({
      name: "@scope/plugin-foo",
      version: "next",
    });
    expect(parsePluginSpec("@scope/plugin-foo")).toEqual({
      name: "@scope/plugin-foo",
      version: undefined,
    });
    expect(() => parsePluginSpec("discord@")).toThrow(
      "Plugin version cannot be empty",
    );
    expect(() => parsePluginSpec("discord@latest next")).toThrow(
      "Invalid plugin version",
    );
  });

  it("accepts real plugin paths under cwd or home", () => {
    const root = makeTempDir();
    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const cwdPluginDir = path.join(cwd, "plugins", "one");
    const homePluginDir = path.join(home, "plugins", "two");
    fs.mkdirSync(cwdPluginDir, { recursive: true });
    fs.mkdirSync(homePluginDir, { recursive: true });
    process.chdir(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    expect(() => validatePluginPath(cwdPluginDir)).not.toThrow();
    expect(() =>
      validatePluginPath(homePluginDir, { cwd, home }),
    ).not.toThrow();
  });

  it("rejects paths outside cwd and home after resolving dot segments", () => {
    const root = makeTempDir();
    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(cwd, "plugins"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    process.chdir(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    expect(() =>
      validatePluginPath(path.join(cwd, "plugins", "..", "..", "outside"), {
        cwd,
        home,
      }),
    ).toThrow("outside allowed boundaries");
  });

  it("rejects symlinked plugin paths that escape cwd and home", () => {
    const root = makeTempDir();
    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const outside = path.join(root, "outside");
    const symlink = path.join(cwd, "plugins", "escape");
    fs.mkdirSync(path.dirname(symlink), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, symlink, "dir");
    process.chdir(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    expect(() => validatePluginPath(symlink, { cwd, home })).toThrow(
      "outside allowed boundaries",
    );
  });
});
