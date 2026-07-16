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
import { buildBrandEnvAliases } from "@elizaos/shared/config/brand-env-aliases";
import { readAliasedEnv } from "@elizaos/shared/utils/env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMobileStateDir } from "./bridge.ts";

const ACME_EDGE_TTS_KEY = "ACME_DISABLE_EDGE_TTS";
const ACME_API_TOKEN_KEY = "ACME_API_TOKEN";
const ACME_VITE_SETTINGS_KEY = "VITE_ACME_SETTINGS_DEBUG";
const UNRELATED_STATE_KEY = "FOO_STATE_DIR";
const UNRELATED_NAMESPACE_KEY = "FOO_NAMESPACE";
const UNRELATED_PLATFORM_KEY = "FOO_PLATFORM";
const UNRELATED_API_PORT_KEY = "FOO_API_PORT";
const UNRELATED_TOKEN_KEY = "FOO_API_TOKEN";
const UNRELATED_NULL_ORIGIN_KEY = "FOO_ALLOW_NULL_ORIGIN";
const UNRELATED_PROVIDER_KEY = "CLOUDFLARE_API_TOKEN";

const TOUCHED_KEYS = [
	"ACME_STATE_DIR",
	"ELIZA_STATE_DIR",
	"ELIZA_NAMESPACE",
	"ELIZA_PLATFORM",
	"ELIZA_API_PORT",
	ACME_EDGE_TTS_KEY,
	ACME_API_TOKEN_KEY,
	"ELIZA_DISABLE_EDGE_TTS",
	ACME_VITE_SETTINGS_KEY,
	"VITE_ELIZA_SETTINGS_DEBUG",
	UNRELATED_STATE_KEY,
	UNRELATED_NAMESPACE_KEY,
	UNRELATED_PLATFORM_KEY,
	UNRELATED_API_PORT_KEY,
	UNRELATED_TOKEN_KEY,
	UNRELATED_NULL_ORIGIN_KEY,
	UNRELATED_PROVIDER_KEY,
	"ELIZA_API_TOKEN",
	"ELIZA_ALLOW_NULL_ORIGIN",
	"ELIZA_HOME",
	"ELIZA_WORKSPACE_DIR",
] as const;

function trustAcmeAliases(): void {
	setBootConfig({
		...getBootConfig(),
		envAliases: buildBrandEnvAliases("ACME"),
	});
}

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

	it("resolves a branded state directory from an explicitly trusted alias table", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		trustAcmeAliases();
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
		trustAcmeAliases();
		expect(resolveMobileStateDir()).toBe("/canonical/state");
	});

	it("treats a blank canonical value as unset and falls back to the brand alias", () => {
		process.env.ELIZA_STATE_DIR = "   ";
		process.env.ACME_STATE_DIR = "/data/acme/state";
		trustAcmeAliases();
		expect(resolveMobileStateDir()).toBe("/data/acme/state");
	});

	it("does not mirror-write the resolved brand value back to ELIZA_STATE_DIR", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		trustAcmeAliases();
		resolveMobileStateDir();
		expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
	});

	it("applies non-bootstrap aliases for a discovered prefix without mirror-writing", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		process.env[ACME_EDGE_TTS_KEY] = "1";
		trustAcmeAliases();

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
		trustAcmeAliases();

		resolveMobileStateDir();

		expect(readAliasedEnv("ELIZA_DISABLE_EDGE_TTS")).toBe("0");
		expect(process.env.ELIZA_DISABLE_EDGE_TTS).toBe("0");
		expect(process.env[ACME_EDGE_TTS_KEY]).toBe("1");
	});

	it("does not promote an unrelated provider credential into Eliza configuration", () => {
		process.env[UNRELATED_PROVIDER_KEY] = "provider-secret";

		resolveMobileStateDir();

		expect(readAliasedEnv("ELIZA_API_TOKEN")).toBeUndefined();
		expect(getBootConfig().envAliases).toBeUndefined();
	});

	it("does not infer trust from arbitrary bootstrap-shaped environment keys", () => {
		process.env[UNRELATED_STATE_KEY] = "/data/foo/state";
		process.env[UNRELATED_NAMESPACE_KEY] = "foo";
		process.env[UNRELATED_PLATFORM_KEY] = "ios";
		process.env[UNRELATED_API_PORT_KEY] = "3131";
		process.env[UNRELATED_TOKEN_KEY] = "provider-secret";
		process.env[UNRELATED_NULL_ORIGIN_KEY] = "1";

		expect(resolveMobileStateDir()).not.toBe("/data/foo/state");
		expect(getBootConfig().envAliases).toBeUndefined();
		expect(readAliasedEnv("ELIZA_STATE_DIR")).toBeUndefined();
		expect(readAliasedEnv("ELIZA_NAMESPACE")).toBeUndefined();
		expect(readAliasedEnv("ELIZA_PLATFORM")).toBeUndefined();
		expect(readAliasedEnv("ELIZA_API_PORT")).toBeUndefined();
		expect(readAliasedEnv("ELIZA_API_TOKEN")).toBeUndefined();
		expect(readAliasedEnv("ELIZA_ALLOW_NULL_ORIGIN")).toBeUndefined();
	});

	it("accepts credential aliases from an explicitly trusted alias table", () => {
		process.env[ACME_API_TOKEN_KEY] = "white-label-secret";
		trustAcmeAliases();

		resolveMobileStateDir();

		expect(readAliasedEnv("ELIZA_API_TOKEN")).toBe("white-label-secret");
		expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
	});

	it("retains the trusted Vite alias shape", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		process.env[ACME_VITE_SETTINGS_KEY] = "1";
		trustAcmeAliases();

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
