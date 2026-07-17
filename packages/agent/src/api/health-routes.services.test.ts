/**
 * Drives the health route against real AgentRuntime service lifecycle states,
 * proving the HTTP payload cannot advertise failed or in-flight boots as ready.
 */
import type http from "node:http";
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
  Service,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HealthRouteContext,
  handleHealthRoutes,
} from "./health-routes.ts";

const ROUTE_FAILURE_SERVICE_TYPE = "health_route_failure_service";

class RouteFailureService extends Service {
  static override readonly serviceType = ROUTE_FAILURE_SERVICE_TYPE;
  static override readonly blocksReadiness = true;

  override capabilityDescription = "Fails so the health route can expose it.";

  static override async start(): Promise<RouteFailureService> {
    throw new Error("health route startup failure");
  }

  override async stop(): Promise<void> {}
}

describe("service health route", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
      await runtime.close();
    }
  });

  it("marks a runtime with a failed startup service as not ready", async () => {
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "HealthRouteServiceFailure" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.initialize();
    await Promise.all(
      runtime
        .getRegisteredServiceTypes()
        .map((serviceType) => runtime.getServiceLoadPromise(serviceType)),
    );
    await runtime.registerPlugin({
      name: "health-route-service-failure-plugin",
      description: "Registers the failing health-route integration service.",
      services: [RouteFailureService],
    });
    await expect(
      runtime.getServiceLoadPromise(ROUTE_FAILURE_SERVICE_TYPE),
    ).rejects.toMatchObject({
      code: "SERVICE_START_FAILED",
      message: "health route startup failure",
    });

    const req = {} as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const json = vi.fn<HealthRouteContext["json"]>();
    const handled = await handleHealthRoutes({
      req,
      res,
      method: "GET",
      pathname: "/api/health",
      url: new URL("http://localhost/api/health"),
      state: {
        runtime,
        config: {},
        agentState: "running",
        agentName: "HealthRouteServiceFailure",
        model: undefined,
        startedAt: Date.now(),
        startup: { phase: "ready", attempt: 1 },
        plugins: [],
        pendingRestartReasons: [],
        connectorHealthMonitor: null,
      },
      json,
      error: vi.fn<HealthRouteContext["error"]>(),
    });

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        ready: false,
        services: expect.objectContaining({
          status: "failed",
          failed: 1,
          failures: [ROUTE_FAILURE_SERVICE_TYPE],
        }),
      }),
    );
  });

  it("stays not ready until a registering service settles", async () => {
    let markStartEntered: () => void = () => undefined;
    let releaseStart: () => void = () => undefined;
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    const startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    class RouteBarrierService extends Service {
      static override readonly serviceType = "health_route_barrier_service";
      static override readonly blocksReadiness = true;

      override capabilityDescription =
        "Holds startup so the health route can expose the registering state.";

      static override async start(
        runtime: IAgentRuntime,
      ): Promise<RouteBarrierService> {
        markStartEntered();
        await startBarrier;
        return new RouteBarrierService(runtime);
      }

      override async stop(): Promise<void> {}
    }

    const runtime = new AgentRuntime({
      character: createCharacter({ name: "HealthRouteServiceBarrier" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.initialize();
    await Promise.all(
      runtime
        .getRegisteredServiceTypes()
        .map((serviceType) => runtime.getServiceLoadPromise(serviceType)),
    );
    await runtime.registerPlugin({
      name: "health-route-service-barrier-plugin",
      description: "Registers a service held behind a deterministic barrier.",
      services: [RouteBarrierService],
    });
    await startEntered;

    const req = {} as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const json = vi.fn<HealthRouteContext["json"]>();
    const context: HealthRouteContext = {
      req,
      res,
      method: "GET",
      pathname: "/api/health",
      url: new URL("http://localhost/api/health"),
      state: {
        runtime,
        config: {},
        agentState: "running",
        agentName: "HealthRouteServiceBarrier",
        model: undefined,
        startedAt: Date.now(),
        startup: { phase: "ready", attempt: 1 },
        plugins: [],
        pendingRestartReasons: [],
        connectorHealthMonitor: null,
      },
      json,
      error: vi.fn<HealthRouteContext["error"]>(),
    };

    try {
      await expect(handleHealthRoutes(context)).resolves.toBe(true);
      expect(json).toHaveBeenLastCalledWith(
        res,
        expect.objectContaining({
          ready: false,
          services: expect.objectContaining({
            status: "starting",
            pendingServices: [RouteBarrierService.serviceType],
          }),
        }),
      );
    } finally {
      releaseStart();
    }

    await expect(
      runtime.getServiceLoadPromise(RouteBarrierService.serviceType),
    ).resolves.toBeInstanceOf(RouteBarrierService);
    await expect(handleHealthRoutes(context)).resolves.toBe(true);
    expect(json).toHaveBeenLastCalledWith(
      res,
      expect.objectContaining({
        ready: true,
        services: expect.objectContaining({
          status: "healthy",
          pendingServices: [],
        }),
      }),
    );
  });

  it("reports an optional service failure without blocking runtime readiness", async () => {
    class OptionalRouteFailureService extends Service {
      static override readonly serviceType =
        "health_route_optional_failure_service";

      override capabilityDescription =
        "Fails without owning a runtime boot invariant.";

      static override async start(): Promise<OptionalRouteFailureService> {
        throw new Error("optional health route startup failure");
      }

      override async stop(): Promise<void> {}
    }

    const runtime = new AgentRuntime({
      character: createCharacter({ name: "OptionalServiceFailure" }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.initialize();
    await Promise.all(
      runtime
        .getRegisteredServiceTypes()
        .map((serviceType) => runtime.getServiceLoadPromise(serviceType)),
    );
    await runtime.registerPlugin({
      name: "optional-service-failure-plugin",
      description: "Registers a non-readiness service that fails startup.",
      services: [OptionalRouteFailureService],
    });
    await expect(
      runtime.getServiceLoadPromise(OptionalRouteFailureService.serviceType),
    ).rejects.toMatchObject({ code: "SERVICE_START_FAILED" });

    const res = {} as http.ServerResponse;
    const json = vi.fn<HealthRouteContext["json"]>();
    await expect(
      handleHealthRoutes({
        req: {} as http.IncomingMessage,
        res,
        method: "GET",
        pathname: "/api/health",
        url: new URL("http://localhost/api/health"),
        state: {
          runtime,
          config: {},
          agentState: "running",
          agentName: "OptionalServiceFailure",
          model: undefined,
          startedAt: Date.now(),
          startup: { phase: "ready", attempt: 1 },
          plugins: [],
          pendingRestartReasons: [],
          connectorHealthMonitor: null,
        },
        json,
        error: vi.fn<HealthRouteContext["error"]>(),
      }),
    ).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        ready: true,
        services: expect.objectContaining({
          status: "failed",
          readinessStatus: "healthy",
          failures: [OptionalRouteFailureService.serviceType],
          blockingFailures: [],
        }),
      }),
    );
  });
});
