/**
 * Exercises `AgentRuntime.stop` fast-shutdown paths: not hanging on an
 * unresolved service start, capping already-started stop waits, and surviving a
 * synchronously-throwing stop. Deterministic: real runtime, no database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function delay(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		setTimeout(() => resolve("timeout"), ms);
	});
}

describe("AgentRuntime.stop", () => {
	const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;
	const previousStopTimeout =
		process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;

	afterEach(() => {
		if (previousFastShutdown === undefined) {
			delete process.env.ELIZA_FAST_SHUTDOWN;
		} else {
			process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
		}
		if (previousStopTimeout === undefined) {
			delete process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
		} else {
			process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = previousStopTimeout;
		}
	});

	it("fast shutdown does not hang on an unresolved service start and cleans up late starts", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		let startRuntime: IAgentRuntime | null = null;
		let stopCalls = 0;
		const start = createDeferred<SlowService>();

		class SlowService extends Service {
			static override serviceType = "shutdown-slow-service";
			capabilityDescription = "slow service used by shutdown tests";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<SlowService> {
				startRuntime = runtime;
				return start.promise;
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
			}
		}

		await runtime.registerService(SlowService);
		const load = runtime.getServiceLoadPromise(SlowService.serviceType).then(
			() => "loaded",
			(error) => (error instanceof Error ? error.message : String(error)),
		);

		await Promise.resolve();
		const stopResult = await Promise.race([
			runtime.stop({ fast: true }).then(() => "stopped"),
			delay(100),
		]);

		expect(stopResult).toBe("stopped");
		expect(stopCalls).toBe(0);
		expect(startRuntime).toBe(runtime);

		start.resolve(new SlowService(runtime));

		await expect(load).resolves.toContain("not found or failed to start");
		expect(stopCalls).toBe(1);
		expect(runtime.getServiceRegistrationStatus(SlowService.serviceType)).toBe(
			"failed",
		);
	});

	it("fast shutdown caps already-started service stop waits", async () => {
		process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = "5";
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let stopCalls = 0;

		class HangingStopService extends Service {
			static override serviceType = "shutdown-hanging-stop-service";
			capabilityDescription = "hanging stop service used by shutdown tests";

			static override async start(): Promise<HangingStopService> {
				return new HangingStopService();
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
				await new Promise(() => {});
			}
		}

		await runtime.registerService(HangingStopService);
		await runtime.getServiceLoadPromise(HangingStopService.serviceType);

		const stopResult = await Promise.race([
			runtime.stop({ fast: true }).then(() => "stopped"),
			delay(100),
		]);

		expect(stopResult).toBe("stopped");
		expect(stopCalls).toBe(1);
		expect(process.env.ELIZA_FAST_SHUTDOWN).toBe(previousFastShutdown);
	});

	it("continues when a service stop throws synchronously", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		class ThrowingStopService extends Service {
			static override serviceType = "shutdown-throwing-stop-service";
			capabilityDescription = "throwing stop service used by shutdown tests";

			static override async start(): Promise<ThrowingStopService> {
				return new ThrowingStopService();
			}

			override stop(): Promise<void> {
				throw new Error("sync stop failure");
			}
		}

		await runtime.registerService(ThrowingStopService);
		await runtime.getServiceLoadPromise(ThrowingStopService.serviceType);

		await expect(runtime.stop()).resolves.toBeUndefined();
	});

	it("reserves plugin disposal for destructive reset teardown", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let disposeCalls = 0;

		await runtime.registerPlugin({
			name: "shutdown-dispose-test",
			description: "Exercises full-runtime plugin cleanup",
			dispose: () => {
				disposeCalls += 1;
			},
		});

		await runtime.stop();
		expect(disposeCalls).toBe(0);

		await runtime.teardownForReset();
		await runtime.teardownForReset();

		expect(disposeCalls).toBe(1);
	});

	it("retries only failed plugin disposal after services have stopped", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let successfulDisposeCalls = 0;
		let retryingDisposeCalls = 0;

		await runtime.registerPlugin({
			name: "shutdown-successful-dispose-test",
			description: "Verifies successful hooks are not repeated",
			dispose: () => {
				successfulDisposeCalls += 1;
			},
		});
		await runtime.registerPlugin({
			name: "shutdown-retrying-dispose-test",
			description: "Verifies failed hooks remain retryable",
			dispose: () => {
				retryingDisposeCalls += 1;
				if (retryingDisposeCalls === 1) throw new Error("retry disposal");
			},
		});

		await expect(runtime.teardownForReset()).rejects.toThrow(
			"Failed to dispose",
		);
		await expect(runtime.teardownForReset()).resolves.toBeUndefined();

		expect(successfulDisposeCalls).toBe(1);
		expect(retryingDisposeCalls).toBe(2);
	});

	it("fails reset teardown until every service has actually stopped", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const close = vi.spyOn(runtime, "close").mockResolvedValue();
		let stopCalls = 0;

		class RetryStopService extends Service {
			static override serviceType = "reset-retry-stop-service";
			capabilityDescription = "fails its first reset stop attempt";

			static override async start(): Promise<RetryStopService> {
				return new RetryStopService();
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
				if (stopCalls === 1) throw new Error("still writing");
			}
		}

		await runtime.registerService(RetryStopService);
		await runtime.getServiceLoadPromise(RetryStopService.serviceType);

		await expect(runtime.teardownForReset()).rejects.toThrow(
			"Failed to stop all runtime services",
		);
		expect(close).not.toHaveBeenCalled();
		await expect(runtime.teardownForReset()).resolves.toBeUndefined();
		expect(stopCalls).toBe(2);
		expect(close).toHaveBeenCalledOnce();
	});

	it("retains a late-starting service until strict reset stop succeeds", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const start = createDeferred<LateResetService>();
		let startEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			startEntered = resolve;
		});
		let stopCalls = 0;

		class LateResetService extends Service {
			static override serviceType = "late-reset-service";
			capabilityDescription = "finishes startup during destructive reset";

			static override async start(): Promise<LateResetService> {
				startEntered();
				return start.promise;
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
				if (stopCalls === 1) throw new Error("late writer still active");
			}
		}

		await runtime.registerService(LateResetService);
		const load = runtime
			.getServiceLoadPromise(LateResetService.serviceType)
			.then(
				() => "loaded",
				(error) => (error instanceof Error ? error.message : String(error)),
			);
		await entered;
		await runtime.stop({ fast: true });
		const teardown = runtime.teardownForReset();
		await Promise.resolve();
		let teardownSettled = false;
		void teardown.then(
			() => {
				teardownSettled = true;
			},
			() => {
				teardownSettled = true;
			},
		);
		await Promise.resolve();
		expect(teardownSettled).toBe(false);
		start.resolve(new LateResetService());

		await expect(teardown).rejects.toThrow(
			"Failed to stop all runtime services",
		);
		await expect(load).resolves.toContain("not found or failed to start");
		await expect(runtime.teardownForReset()).resolves.toBeUndefined();
		expect(stopCalls).toBe(2);
	});

	it("shares one destructive teardown across concurrent reset callers", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let disposeCalls = 0;

		await runtime.registerPlugin({
			name: "concurrent-reset-dispose-test",
			description: "holds reset teardown open for concurrent callers",
			dispose: async () => {
				disposeCalls += 1;
				await disposeGate;
			},
		});

		const first = runtime.teardownForReset();
		const second = runtime.teardownForReset();
		await Promise.resolve();
		expect(disposeCalls).toBe(1);
		releaseDispose();
		await Promise.all([first, second]);
		expect(disposeCalls).toBe(1);
	});
});
