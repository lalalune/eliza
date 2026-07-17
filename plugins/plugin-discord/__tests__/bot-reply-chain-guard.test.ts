/**
 * Exercises the deterministic Discord bot-reply bound with adversarial chains,
 * human resets, inactivity resets, independent channels, and invalid config.
 */
import { describe, expect, it } from "vitest";
import {
	BOT_REPLY_CHAIN_WINDOW_MS,
	BotReplyChainGuard,
	DEFAULT_BOT_REPLY_CHAIN_LIMIT,
	resolveBotReplyChainLimit,
} from "../bot-reply-chain-guard.ts";

const addressedBot = (channelId = "channel-a") => ({
	channelId,
	authorIsBot: true,
	directlyAddressesAgent: true,
});

describe("BotReplyChainGuard", () => {
	it("blocks the first turn beyond the configured addressed-bot budget", () => {
		const guard = new BotReplyChainGuard(3, () => 1_000);
		expect(guard.observe(addressedBot()).blocked).toBe(false);
		expect(guard.observe(addressedBot()).blocked).toBe(false);
		expect(guard.observe(addressedBot()).blocked).toBe(false);
		expect(guard.observe(addressedBot())).toEqual({
			blocked: true,
			count: 4,
			limit: 3,
		});
	});

	it("opens a fresh exchange after a human participates", () => {
		const guard = new BotReplyChainGuard(1, () => 1_000);
		expect(guard.observe(addressedBot()).blocked).toBe(false);
		expect(guard.observe(addressedBot()).blocked).toBe(true);
		guard.observe({
			channelId: "channel-a",
			authorIsBot: false,
			directlyAddressesAgent: true,
		});
		expect(guard.observe(addressedBot()).blocked).toBe(false);
	});

	it("opens a fresh exchange after the inactivity window", () => {
		let now = 1_000;
		const guard = new BotReplyChainGuard(1, () => now);
		expect(guard.observe(addressedBot()).blocked).toBe(false);
		expect(guard.observe(addressedBot()).blocked).toBe(true);
		now += BOT_REPLY_CHAIN_WINDOW_MS;
		expect(guard.observe(addressedBot())).toEqual({
			blocked: false,
			count: 1,
			limit: 1,
		});
	});

	it("does not let other channels or unaddressed bot noise consume the budget", () => {
		const guard = new BotReplyChainGuard(1, () => 1_000);
		expect(guard.observe(addressedBot("channel-a")).blocked).toBe(false);
		expect(guard.observe(addressedBot("channel-b")).blocked).toBe(false);
		expect(
			guard.observe({
				channelId: "channel-a",
				authorIsBot: true,
				directlyAddressesAgent: false,
			}).blocked,
		).toBe(false);
		expect(guard.observe(addressedBot("channel-a")).blocked).toBe(true);
	});

	it("allows an explicit zero limit to disable the bound", () => {
		const guard = new BotReplyChainGuard(0, () => 1_000);
		for (let index = 0; index < 100; index += 1) {
			expect(guard.observe(addressedBot()).blocked).toBe(false);
		}
	});

	it("evicts old channel state when an adversary fans out across channels", () => {
		const guard = new BotReplyChainGuard(1, () => 1_000);
		for (let index = 0; index <= 1_000; index += 1) {
			expect(guard.observe(addressedBot(`channel-${index}`)).blocked).toBe(
				false,
			);
		}
		// channel-0 was the oldest entry, so revisiting it starts a fresh chain.
		expect(guard.observe(addressedBot("channel-0")).blocked).toBe(false);
	});
});

describe("resolveBotReplyChainLimit", () => {
	it("defaults to a bounded exchange and accepts an explicit override", () => {
		expect(resolveBotReplyChainLimit(undefined)).toBe(
			DEFAULT_BOT_REPLY_CHAIN_LIMIT,
		);
		expect(resolveBotReplyChainLimit("7")).toBe(7);
		expect(resolveBotReplyChainLimit(0)).toBe(0);
	});

	it.each(["nope", -1, 1.5])("rejects invalid limit %j", (value) => {
		expect(() => resolveBotReplyChainLimit(value)).toThrow(
			/DISCORD_BOT_REPLY_CHAIN_LIMIT/,
		);
	});
});
