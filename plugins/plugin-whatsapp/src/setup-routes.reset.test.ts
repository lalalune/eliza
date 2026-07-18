/**
 * Verifies that plugin-level WhatsApp pairing disposal drains sessions and invalidates late events.
 * The pairing transport and runtime are deterministic; no real account or network is used.
 */

import {
  AgentRuntime,
  type IAgentRuntime,
  type RouteRequest,
  type RouteResponse,
  Service,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

type PairingEvent = {
  type: "whatsapp-qr" | "whatsapp-status";
  accountId: string;
  status?: string;
  phoneNumber?: string;
};

type PairingOptions = {
  authDir: string;
  accountId: string;
  onEvent: (event: PairingEvent) => void;
};

class FakePairingSession {
  static instances: FakePairingSession[] = [];
  readonly start = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  private status = "initializing";

  constructor(readonly options: PairingOptions) {
    FakePairingSession.instances.push(this);
  }

  getStatus(): string {
    return this.status;
  }

  emit(event: PairingEvent): void {
    if (event.status) this.status = event.status;
    this.options.onEvent(event);
  }
}

class FakeConnectorSetupService extends Service {
  static override serviceType = "connector-setup";
  override capabilityDescription = "Connector setup state for WhatsApp route tests";
  readonly config: Record<string, unknown> = {
    connectors: {} as Record<string, unknown>,
  };
  readonly getConfig = vi.fn(() => this.config);
  readonly persistConfig = vi.fn((_config: Record<string, unknown>) => undefined);
  readonly updateConfig = vi.fn((updater: (config: Record<string, unknown>) => void) =>
    updater(this.config)
  );
  readonly registerEscalationChannel = vi.fn((_channelName: string) => true);
  readonly setOwnerContact = vi.fn(
    (_update: { source: string; channelId?: string; entityId?: string; roomId?: string }) => true
  );
  readonly getWorkspaceDir = vi.fn(() => "/tmp/eliza-whatsapp-workspace");
  readonly broadcastWs = vi.fn((_data: object) => undefined);

  static override async start(runtime: IAgentRuntime): Promise<FakeConnectorSetupService> {
    return new FakeConnectorSetupService(runtime);
  }

  override async stop(): Promise<void> {}
}

function sanitizeAccountId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned || cleaned !== raw) throw new Error("invalid accountId");
  return cleaned;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createResponse() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
    send: vi.fn(() => response),
    end: vi.fn(() => response),
  };
  return response as typeof response & RouteResponse;
}

async function loadSetupRoutes() {
  vi.resetModules();
  FakePairingSession.instances = [];
  vi.doMock("./pairing-service.js", () => ({
    sanitizeAccountId,
    WhatsAppPairingSession: FakePairingSession,
    whatsappAuthExists: vi.fn(() => false),
    whatsappLogout: vi.fn(async () => undefined),
  }));
  return import("./setup-routes");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("WhatsApp setup route reset quiescence", () => {
  it("waits for session stop, rejects late events, and prevents starts after disposal", async () => {
    const { stopAllPairingSessions, whatsappSetupRoutes } = await loadSetupRoutes();
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    await runtime.registerService(FakeConnectorSetupService);
    const registeredService = await runtime.getServiceLoadPromise(
      FakeConnectorSetupService.serviceType
    );
    if (!(registeredService instanceof FakeConnectorSetupService)) {
      throw new Error("Connector setup test service did not register with AgentRuntime");
    }
    const setupService = registeredService;

    try {
      const pairRoute = whatsappSetupRoutes.find(
        (route) => route.type === "POST" && route.path === "/api/whatsapp/pair"
      );
      if (!pairRoute) throw new Error("WhatsApp pairing route is not registered");

      const initialResponse = createResponse();
      await pairRoute.handler(
        { body: { accountId: "default" } } as RouteRequest,
        initialResponse,
        runtime
      );
      expect(initialResponse.statusCode).toBe(200);
      const session = FakePairingSession.instances[0];
      const allowStop = deferred();
      session.stop.mockImplementation(async () => allowStop.promise);

      let disposeSettled = false;
      const dispose = stopAllPairingSessions().then(() => {
        disposeSettled = true;
      });
      await Promise.resolve();
      expect(disposeSettled).toBe(false);

      session.emit({
        type: "whatsapp-status",
        accountId: "default",
        status: "connected",
        phoneNumber: "+15555550123",
      });
      expect(setupService.updateConfig).not.toHaveBeenCalled();
      expect(setupService.setOwnerContact).not.toHaveBeenCalled();
      expect(setupService.broadcastWs).not.toHaveBeenCalled();

      allowStop.resolve();
      await dispose;

      const rejectedResponse = createResponse();
      await pairRoute.handler(
        { body: { accountId: "default" } } as RouteRequest,
        rejectedResponse,
        runtime
      );
      expect(rejectedResponse.statusCode).toBe(503);
      expect(FakePairingSession.instances).toHaveLength(1);
    } finally {
      await runtime.stop({ fast: true });
    }
  });
});
