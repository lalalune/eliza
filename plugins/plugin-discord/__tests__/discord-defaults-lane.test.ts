/**
 * Coverage lane for the connector's conversational default posture across
 * `environment.ts`, `messages.ts`, the startup lifecycle, and slash commands.
 * The changed-file coverage gate runs only the test files in a PR diff, so this
 * lane re-composes the existing behavioral suites and directly verifies the
 * production banner and `/settings` output until each module is independently
 * unit-covered. Mirrors the messages/service regression lanes.
 */

import { stripVTControlCharacters } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { printDiscordBanner } from "../banner.ts";
import { DISCORD_SERVICE_NAME } from "../constants.ts";
import discordPlugin from "../index.ts";
import { getRegisteredCommands } from "../slash-commands.ts";
import "./ask-command-and-groupdm.test.ts";
import "./messages-regression-lane.test.ts";
import "./service-regression-lane.test.ts";
import "./banner-reply-warning.test.ts";
import "./environment-defaults.test.ts";
import "./help-status-commands.test.ts";
import "./slash-command-dispatch-cooldown-and-errors.test.ts";
import "./slash-command-registry.test.ts";

describe("discord defaults lane composition", () => {
	it("renders the startup banner with the conversational defaults", () => {
		const settings: Record<string, unknown> = {
			DISCORD_API_TOKEN: "token-value",
			DISCORD_APPLICATION_ID: "123456789012345678", // gitleaks:allow test fixture
		};
		const info = vi.fn();
		const runtime = {
			character: { name: "TestBot" },
			getSetting: (key: string) => settings[key],
			logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		} as unknown as IAgentRuntime;

		printDiscordBanner(runtime);

		const rendered = info.mock.calls
			.map((call) => stripVTControlCharacters(String(call[0])))
			.join("\n");
		expect(rendered).toMatch(
			/DISCORD_SHOULD_IGNORE_BOT_MESSAGES\s+false\s+unset/,
		);
		expect(rendered).toMatch(
			/DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS\s+false\s+unset/,
		);
		expect(rendered).toMatch(/DISCORD_BOT_REPLY_CHAIN_LIMIT\s+3\s+unset/);
	});

	it("uses the current banner from the production plugin lifecycle", async () => {
		const stop = vi.fn(async () => undefined);
		const register = vi.fn();
		const info = vi.fn();
		const runtime = {
			agentId: "11111111-1111-1111-1111-111111111111",
			character: { name: "TestBot" },
			getSetting: (key: string) =>
				key === "DISCORD_API_TOKEN" ? "token-value" : undefined,
			getService: (name: string) =>
				name === DISCORD_SERVICE_NAME ? { stop } : { register },
			logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		} as unknown as IAgentRuntime;

		await discordPlugin.init?.({}, runtime);
		await discordPlugin.dispose?.(runtime);

		const rendered = info.mock.calls
			.map((call) => stripVTControlCharacters(String(call[0])))
			.join("\n");
		expect(rendered).toMatch(
			/DISCORD_SHOULD_IGNORE_BOT_MESSAGES\s+false\s+unset/,
		);
		expect(stop).toHaveBeenCalledOnce();
	});

	it("reports the conversational bot-message default through /settings", async () => {
		const command = getRegisteredCommands().get("settings");
		if (!command) throw new Error("settings command not registered");
		const reply = vi.fn(async () => undefined);
		const interaction = {
			options: { getString: () => "view" },
			reply,
		};
		const runtime = {
			character: { name: "TestBot" },
			getSetting: () => undefined,
		} as unknown as IAgentRuntime;

		await command.execute(interaction as never, runtime);

		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("Ignore bot messages: **false**"),
			}),
		);
	});
});
