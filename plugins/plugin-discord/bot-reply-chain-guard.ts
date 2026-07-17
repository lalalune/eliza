/**
 * Bounds addressed bot-to-bot reply chains before they reach the model. The
 * connector still permits short agent conversations, while a human message or
 * one minute of inactivity opens a fresh bounded exchange.
 */
import { ElizaError } from "@elizaos/core";

export const DEFAULT_BOT_REPLY_CHAIN_LIMIT = 3;
export const BOT_REPLY_CHAIN_WINDOW_MS = 60_000;
const MAX_TRACKED_CHANNELS = 1_000;

export interface BotReplyChainObservation {
	channelId: string;
	authorIsBot: boolean;
	directlyAddressesAgent: boolean;
}

export interface BotReplyChainDecision {
	blocked: boolean;
	count: number;
	limit: number;
}

export function resolveBotReplyChainLimit(value: unknown): number {
	if (value === undefined || value === null || String(value).trim() === "") {
		return DEFAULT_BOT_REPLY_CHAIN_LIMIT;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new ElizaError(
			"DISCORD_BOT_REPLY_CHAIN_LIMIT must be a non-negative integer",
			{
				code: "DISCORD_BOT_REPLY_CHAIN_LIMIT_INVALID",
				context: { value },
			},
		);
	}
	return parsed;
}

export class BotReplyChainGuard {
	private readonly channels = new Map<
		string,
		{ count: number; lastAddressedBotAt: number }
	>();

	constructor(
		private readonly limit: number,
		private readonly now: () => number = Date.now,
	) {}

	observe(observation: BotReplyChainObservation): BotReplyChainDecision {
		if (!observation.authorIsBot) {
			this.channels.delete(observation.channelId);
			return { blocked: false, count: 0, limit: this.limit };
		}
		if (!observation.directlyAddressesAgent || this.limit === 0) {
			return { blocked: false, count: 0, limit: this.limit };
		}

		const now = this.now();
		for (const [channelId, state] of this.channels) {
			if (now - state.lastAddressedBotAt >= BOT_REPLY_CHAIN_WINDOW_MS) {
				this.channels.delete(channelId);
			}
		}

		const previous = this.channels.get(observation.channelId);
		const count = previous ? previous.count + 1 : 1;
		this.channels.delete(observation.channelId);
		this.channels.set(observation.channelId, {
			count,
			lastAddressedBotAt: now,
		});

		if (this.channels.size > MAX_TRACKED_CHANNELS) {
			const oldestChannelId = this.channels.keys().next().value;
			if (typeof oldestChannelId === "string") {
				this.channels.delete(oldestChannelId);
			}
		}

		return { blocked: count > this.limit, count, limit: this.limit };
	}
}
