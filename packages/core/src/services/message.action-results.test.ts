/**
 * Public action-result propagation through the real message-service turn. The
 * model boundary is deterministic, while routing, planning, action execution,
 * clipboard projection, state composition, and connector delivery are real.
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Action } from "../types/components";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import {
	asUUID,
	ChannelType,
	type Content,
	type UUID,
} from "../types/primitives";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-00000000006a" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-00000000006b" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000006c" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-00000000006d" as UUID;
const activeRuntimes: AgentRuntime[] = [];

function makeMessage(): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: "Edit my dashboard view",
			source: "client_chat",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	};
}

function stageOneActionResponse() {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "The requested view edit needs the registered action.",
					contexts: ["general"],
					intents: [],
					candidateActionNames: ["EDIT_DASHBOARD_VIEW"],
					replyText: "Starting the view edit.",
					facts: [],
					relationships: [],
					addressedTo: [],
					requiresTool: true,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

async function makeRuntime(action: Action) {
	const responseHandlerResults: Array<
		ReturnType<typeof stageOneActionResponse> | string
	> = [
		stageOneActionResponse(),
		JSON.stringify({
			success: true,
			decision: "FINISH",
			thought: "The view edit task started.",
			messageToUser: "The view edit task is running.",
		}),
	];
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: createCharacter({
			name: "MessageActionResultsIntegrationAgent",
			bio: "test agent",
		}),
		adapter: new InMemoryDatabaseAdapter(),
		settings: { ACTION_CALLBACK_VOICE_REWRITE: "false" },
		logLevel: "fatal",
		enableAutonomy: false,
	});
	activeRuntimes.push(runtime);
	await runtime.initialize();
	runtime.registerAction(action);
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => [0.1, 0.2, 0.3],
		"message-action-results-test",
	);
	runtime.registerModel(
		ModelType.RESPONSE_HANDLER,
		async () => {
			const response = responseHandlerResults.shift();
			if (response === undefined) {
				throw new Error("Unexpected extra RESPONSE_HANDLER call");
			}
			return response;
		},
		"message-action-results-test",
	);
	runtime.registerModel(
		ModelType.ACTION_PLANNER,
		async () => ({
			text: "",
			toolCalls: [
				{
					id: "edit-view-1",
					name: "EDIT_DASHBOARD_VIEW",
					arguments: {},
				},
			],
		}),
		"message-action-results-test",
	);
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async () => "The view edit task is running.",
		"message-action-results-test",
	);
	await runtime.ensureConnection({
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		userName: "Test User",
		name: "Test User",
		source: "client_chat",
		type: ChannelType.DM,
		metadata: {
			roles: { [ENTITY_ID]: "USER" },
			roleSources: { [ENTITY_ID]: "manual" },
		},
	});
	const useModel = vi.spyOn(runtime, "useModel");
	return { runtime, useModel };
}

describe("DefaultMessageService action-result propagation", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(
			activeRuntimes.splice(0).map(async (runtime) => {
				await runtime.stop();
				await runtime.close();
			}),
		);
	});

	it("returns the action outcome without exposing its sensitive execution payload", async () => {
		const action: Action = {
			name: "EDIT_DASHBOARD_VIEW",
			description: "Starts a verified dashboard view edit.",
			contexts: ["general"],
			suppressActionResultClipboard: true,
			validate: vi.fn(async () => true),
			handler: vi.fn(async () => ({
				success: true,
				text: "The view edit task is running.",
				userFacingText: "The view edit task is running.",
				verifiedUserFacing: true,
				values: { workdir: "/private/worktree/must-not-leak" },
				data: {
					taskSessionId: "session-must-not-leak",
				},
				continueChain: false,
			})),
		};
		const { runtime, useModel } = await makeRuntime(action);
		const deliveries: Content[] = [];

		const result = await new DefaultMessageService().handleMessage(
			runtime,
			makeMessage(),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);

		expect(result.actionResults).toEqual([
			{
				success: true,
				text: "The view edit task is running.",
				userFacingText: "The view edit task is running.",
				verifiedUserFacing: true,
				data: { actionName: "EDIT_DASHBOARD_VIEW" },
				continueChain: false,
			},
		]);
		expect(result.state.data.actionResults).toEqual(result.actionResults);
		expect(
			deliveries.some((content) => content.text?.includes("view edit")),
		).toBe(true);
		const observable = JSON.stringify({
			result,
			deliveries,
			calls: useModel.mock.calls,
		});
		expect(observable).not.toContain("must-not-leak");
	});
});
