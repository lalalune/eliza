/**
 * Exercises real AgentRuntime service startup failure reporting and health
 * state with the in-memory database adapter; no service registry is mocked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "./character.ts";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter.ts";
import { AgentRuntime } from "./runtime.ts";
import type { IAgentRuntime } from "./types/runtime.ts";
import { Service } from "./types/service.ts";

const FAILURE_SERVICE_TYPE = "integration_failure_service";
const INIT_FAILURE_SERVICE_TYPE = "init_registered_failure_service";
const MULTI_SERVICE_TYPE = "multi_implementation_service";
const FINALIZATION_FAILURE_SERVICE_TYPE = "finalization_failure_service";
let finalizationStopCalls = 0;

class FailingBootService extends Service {
	static override readonly serviceType = FAILURE_SERVICE_TYPE;

	override capabilityDescription = "Fails deterministically during startup.";

	static override async start(): Promise<FailingBootService> {
		throw new Error("fresh boot dependency is unavailable");
	}

	override async stop(): Promise<void> {}
}

class InitRegisteredFailingService extends Service {
	static override readonly serviceType = INIT_FAILURE_SERVICE_TYPE;

	override capabilityDescription = "Fails after plugin init registration.";

	static override async start(): Promise<InitRegisteredFailingService> {
		throw new Error("init-registered service failed");
	}

	override async stop(): Promise<void> {}
}

class FailingMultipleService extends Service {
	static override readonly serviceType = MULTI_SERVICE_TYPE;
	static override readonly allowsMultiple = true;

	override capabilityDescription = "The unavailable implementation.";

	static override async start(): Promise<FailingMultipleService> {
		throw new Error("first implementation unavailable");
	}

	override async stop(): Promise<void> {}
}

class WorkingMultipleService extends Service {
	static override readonly serviceType = MULTI_SERVICE_TYPE;
	static override readonly allowsMultiple = true;

	override capabilityDescription = "The available implementation.";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<WorkingMultipleService> {
		return new WorkingMultipleService(runtime);
	}

	override async stop(): Promise<void> {}
}

class FinalizationFailingService extends Service {
	static override readonly serviceType = FINALIZATION_FAILURE_SERVICE_TYPE;

	override capabilityDescription = "Fails while registering send handlers.";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<FinalizationFailingService> {
		return new FinalizationFailingService(runtime);
	}

	static override registerSendHandlers(runtime: IAgentRuntime): void {
		runtime.registerSendHandler("partial-finalization", async () => undefined);
		throw new Error("send-handler finalization failed");
	}

	override async stop(): Promise<void> {
		finalizationStopCalls += 1;
	}
}

describe("AgentRuntime service startup observability", () => {
	const runtimes: AgentRuntime[] = [];

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) {
			await runtime.stop();
			await runtime.close();
		}
	});

	it("reports a typed failure with plugin context and marks service health failed", async () => {
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "ServiceFailureIntegration" }),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtimes.push(runtime);
		await runtime.initialize();

		await runtime.registerPlugin({
			name: "service-failure-integration-plugin",
			description: "Registers a service whose real start method fails.",
			services: [FailingBootService],
		});

		await expect(
			runtime.getServiceLoadPromise(FAILURE_SERVICE_TYPE),
		).rejects.toMatchObject({
			code: "SERVICE_START_FAILED",
			message: "fresh boot dependency is unavailable",
			cause: expect.objectContaining({
				message: "fresh boot dependency is unavailable",
			}),
		});

		expect(runtime.getServiceRegistrationStatus(FAILURE_SERVICE_TYPE)).toBe(
			"failed",
		);
		expect(runtime.getServiceHealth()[FAILURE_SERVICE_TYPE]).toEqual(
			expect.objectContaining({ status: "failed", instances: 0 }),
		);
		expect(runtime.getRecentReportedErrors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scope: "AgentRuntime.serviceStart",
					code: "SERVICE_START_FAILED",
					message: "fresh boot dependency is unavailable",
					context: expect.objectContaining({
						plugin: "service-failure-integration-plugin",
						serviceType: FAILURE_SERVICE_TYPE,
						serviceClass: "FailingBootService",
					}),
				}),
			]),
		);
	});

	it("attributes a service registered from plugin init to its owning plugin", async () => {
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "InitServiceFailureIntegration" }),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtimes.push(runtime);
		await runtime.initialize();

		await runtime.registerPlugin({
			name: "init-service-failure-plugin",
			description: "Registers a failing service from init.",
			init: async (_config, initializedRuntime) => {
				await initializedRuntime.registerService(InitRegisteredFailingService);
			},
		});
		await expect(
			runtime.getServiceLoadPromise(INIT_FAILURE_SERVICE_TYPE),
		).rejects.toMatchObject({
			code: "SERVICE_START_FAILED",
			message: "init-registered service failed",
		});
		expect(runtime.getRecentReportedErrors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scope: "AgentRuntime.serviceStart",
					context: expect.objectContaining({
						plugin: "init-service-failure-plugin",
						serviceType: INIT_FAILURE_SERVICE_TYPE,
					}),
				}),
			]),
		);
	});

	it("keeps service health registered when a later implementation succeeds", async () => {
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "MultiServiceIntegration" }),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtimes.push(runtime);
		await runtime.initialize();
		await runtime.registerPlugin({
			name: "multi-service-integration-plugin",
			description:
				"Registers one unavailable and one available implementation.",
			services: [FailingMultipleService, WorkingMultipleService],
		});

		await expect(
			runtime.getServiceLoadPromise(MULTI_SERVICE_TYPE),
		).resolves.toBeInstanceOf(WorkingMultipleService);
		expect(runtime.getServiceRegistrationStatus(MULTI_SERVICE_TYPE)).toBe(
			"registered",
		);
		expect(runtime.getServiceHealth()[MULTI_SERVICE_TYPE]).toEqual(
			expect.objectContaining({ status: "registered", instances: 1 }),
		);
	});

	it("does not publish a service whose send-handler finalization fails", async () => {
		finalizationStopCalls = 0;
		let originalSendCalls = 0;
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "ServiceFinalizationIntegration" }),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtimes.push(runtime);
		await runtime.initialize();
		runtime.registerSendHandler("partial-finalization", async () => {
			originalSendCalls += 1;
			return undefined;
		});
		await runtime.registerPlugin({
			name: "service-finalization-integration-plugin",
			description: "Registers a service with a failing finalization hook.",
			services: [FinalizationFailingService],
		});

		await expect(
			runtime.getServiceLoadPromise(FINALIZATION_FAILURE_SERVICE_TYPE),
		).rejects.toMatchObject({
			code: "SERVICE_START_FAILED",
			message: "send-handler finalization failed",
		});
		expect(runtime.getService(FINALIZATION_FAILURE_SERVICE_TYPE)).toBeNull();
		await runtime.sendMessageToTarget(
			{ source: "partial-finalization" },
			{ text: "restored handler", agentVoiced: true },
		);
		expect(originalSendCalls).toBe(1);
		expect(
			runtime
				.getMessageConnectors()
				.filter((connector) => connector.source === "partial-finalization"),
		).toHaveLength(1);
		expect(finalizationStopCalls).toBe(1);
	});
});
