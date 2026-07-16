/**
 * Alias-aware environment discovery for the iOS bridge (#13422). Drives the
 * real bridge boot state and `process.env` without mocks, covering the full
 * shared alias catalog, canonical precedence, Vite-key shape, and zero mirror
 * writes.
 */

import {
	getBootConfig,
	setBootConfig,
} from "@elizaos/shared/config/boot-config-store";
import { readAliasedEnv } from "@elizaos/shared/utils/env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMobileStateDir } from "./bridge.ts";

const ACME_EDGE_TTS_KEY = "ACME_DISABLE_EDGE_TTS";
const ACME_VITE_SETTINGS_KEY = "VITE_ACME_SETTINGS_DEBUG";
const UNRELATED_PROVIDER_KEY = "CLOUDFLARE_API_TOKEN";

const TOUCHED_KEYS = [
	"ACME_STATE_DIR",
	"ELIZA_STATE_DIR",
	ACME_EDGE_TTS_KEY,
	"ELIZA_DISABLE_EDGE_TTS",
	ACME_VITE_SETTINGS_KEY,
	"VITE_ELIZA_SETTINGS_DEBUG",
	UNRELATED_PROVIDER_KEY,
	"ELIZA_API_TOKEN",
	"ELIZA_HOME",
	"ELIZA_WORKSPACE_DIR",
] as const;

describe("iOS bridge environment alias resolution", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedBootConfig: ReturnType<typeof getBootConfig>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of TOUCHED_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		savedBootConfig = getBootConfig();
		setBootConfig({
			...savedBootConfig,
			envAliases: undefined,
		});
	});

	afterEach(() => {
		for (const key of TOUCHED_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		setBootConfig(savedBootConfig);
	});

	it("seeds aliases for a branded prefix present in the bridge environment", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		expect(resolveMobileStateDir()).toBe("/data/acme/state");
		expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/data/acme/state");
		expect(getBootConfig().envAliases).toContainEqual([
			"ACME_STATE_DIR",
			"ELIZA_STATE_DIR",
		]);
	});

	it("prefers the canonical ELIZA_STATE_DIR over the brand alias", () => {
		process.env.ELIZA_STATE_DIR = "/canonical/state";
		process.env.ACME_STATE_DIR = "/data/acme/state";
		expect(resolveMobileStateDir()).toBe("/canonical/state");
	});

	it("treats a blank canonical value as unset and falls back to the brand alias", () => {
		process.env.ELIZA_STATE_DIR = "   ";
		process.env.ACME_STATE_DIR = "/data/acme/state";
		expect(resolveMobileStateDir()).toBe("/data/acme/state");
	});

	it("does not mirror-write the resolved brand value back to ELIZA_STATE_DIR", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		resolveMobileStateDir();
		expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
	});

	it("applies non-bootstrap aliases for a discovered prefix without mirror-writing", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		process.env[ACME_EDGE_TTS_KEY] = "1";

		resolveMobileStateDir();

		expect(getBootConfig().envAliases).toContainEqual([
			ACME_EDGE_TTS_KEY,
			"ELIZA_DISABLE_EDGE_TTS",
		]);
		expect(readAliasedEnv("ELIZA_DISABLE_EDGE_TTS")).toBe("1");
		expect(process.env.ELIZA_DISABLE_EDGE_TTS).toBeUndefined();
	});

	it("keeps the canonical non-bootstrap value ahead of its alias", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		process.env[ACME_EDGE_TTS_KEY] = "1";
		process.env.ELIZA_DISABLE_EDGE_TTS = "0";

		resolveMobileStateDir();

		expect(readAliasedEnv("ELIZA_DISABLE_EDGE_TTS")).toBe("0");
		expect(process.env.ELIZA_DISABLE_EDGE_TTS).toBe("0");
		expect(process.env[ACME_EDGE_TTS_KEY]).toBe("1");
	});

	it("does not promote an unrelated provider credential into Eliza configuration", () => {
		process.env[UNRELATED_PROVIDER_KEY] = "provider-secret";

		resolveMobileStateDir();

		expect(readAliasedEnv("ELIZA_API_TOKEN")).toBeUndefined();
		expect(getBootConfig().envAliases).not.toContainEqual([
			UNRELATED_PROVIDER_KEY,
			"ELIZA_API_TOKEN",
		]);
	});

	it("retains Vite aliases without inferring a non-Vite prefix", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		process.env[ACME_VITE_SETTINGS_KEY] = "1";

		resolveMobileStateDir();

		const aliases = getBootConfig().envAliases;
		expect(aliases).toContainEqual([
			ACME_VITE_SETTINGS_KEY,
			"VITE_ELIZA_SETTINGS_DEBUG",
		]);
		expect(aliases).not.toContainEqual([
			ACME_VITE_SETTINGS_KEY,
			"ELIZA_SETTINGS_DEBUG",
		]);
		expect(
			aliases?.some(([brandKey]) => brandKey.startsWith("VITE_VITE_ACME_")),
		).toBe(false);
	});
});
