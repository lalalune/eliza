/**
 * Public action-result propagation through the real message-service turn. The
 * model boundary is deterministic, while routing, planning, action execution,
 * clipboard projection, state composition, and connector delivery are real.
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import { createMockRuntime } from "../testing/mock-runtime";
import type { Action } from "../types/components";
import type { Room } from "../types/environment";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import {
	asUUID,
	ChannelType,
	type Content,
	type UUID,
} from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-00000000006a" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-00000000006b" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000006c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000006d" as UUID;

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

function makeRoom(): Room {
	return {
		id: ROOM_ID,
		source: "client_chat",
		type: ChannelType.DM,
	} as Room;
}

function makeState(): State {
	return {
		values: { availableContexts: "general" },
		data: {},
		text: "",
	};
}

function makeLogger(): IAgentRuntime["logger"] {
	const ignoreLog: IAgentRuntime["logger"]["debug"] = () => {};
	let logger: IAgentRuntime["logger"];
	logger = {
		level: "silent",
		trace: ignoreLog,
		debug: ignoreLog,
		info: ignoreLog,
		warn: ignoreLog,
		error: ignoreLog,
		fatal: ignoreLog,
		success: ignoreLog,
		progress: ignoreLog,
		log: ignoreLog,
		clear: () => {},
		child: () => logger,
	};
	return logger;
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

function makeRuntime(action: Action): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
} {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	const responseHandlerResults: unknown[] = [
		stageOneActionResponse(),
		JSON.stringify({
			success: true,
			decision: "FINISH",
			thought: "The view edit task started.",
			messageToUser: "The view edit task is running.",
		}),
	];
	const useModel = vi.fn(async (modelType: unknown) => {
		switch (String(modelType)) {
			case String(ModelType.TEXT_EMBEDDING):
				return [0.1, 0.2, 0.3];
			case String(ModelType.RESPONSE_HANDLER): {
				const response = responseHandlerResults.shift();
				if (response === undefined) {
					throw new Error("Unexpected extra RESPONSE_HANDLER call");
				}
				return response;
			}
			case String(ModelType.ACTION_PLANNER):
				return {
					text: "",
					toolCalls: [
						{
							id: "edit-view-1",
							name: "EDIT_DASHBOARD_VIEW",
							arguments: {},
						},
					],
				};
			case String(ModelType.TEXT_SMALL):
				return "The view edit task is running.";
			default:
				throw new Error(`Unexpected model call: ${String(modelType)}`);
		}
	});
	const room = makeRoom();
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		character: { name: "Remilio", bio: "test agent" },
		actions: [action],
		providers: [],
		logger: makeLogger(),
		getSetting: vi.fn((key: string) =>
			key === "ACTION_CALLBACK_VOICE_REWRITE" ? "false" : undefined,
		),
		getService: vi.fn(() => null),
		getServicesByType: vi.fn(() => []),
		getModel: vi.fn(() => async () => ""),
		useModel,
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		endRun: vi.fn(),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async () => asUUID(v4())),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		getRoom: vi.fn(async () => room),
		getRoomsByIds: vi.fn(async () => [room]),
		getMemories: vi.fn(async () => []),
		isCheckShouldRespondEnabled: vi.fn(() => true),
		turnControllers: new TurnControllerRegistry(),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
	});
	return { runtime, useModel };
}

describe("DefaultMessageService action-result propagation", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
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
		const { runtime, useModel } = makeRuntime(action);
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
