/**
 * Drives the health route against a real AgentRuntime whose service start
 * fails, proving the HTTP payload cannot advertise that boot as ready.
 */
import type http from "node:http";
import {
  AgentRuntime,
  createCharacter,
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
});
