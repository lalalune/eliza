/** Relay lifecycle tests keep managed containers from opening a local Cloud relay loop. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudManagedGatewayRelayService } from "./cloud-managed-gateway-relay.js";

const originalProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

afterEach(() => {
  if (originalProvisioned === undefined) {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  } else {
    process.env.ELIZA_CLOUD_PROVISIONED = originalProvisioned;
  }
});

describe("CloudManagedGatewayRelayService", () => {
  it('stays stopped for ELIZA_CLOUD_PROVISIONED="true"', async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = " TrUe ";
    const getService = vi.fn();
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: { name: "Managed Agent" },
      messageService: {},
      getService,
    } as unknown as IAgentRuntime;

    const service = await CloudManagedGatewayRelayService.start(runtime);
    expect(service).toBeInstanceOf(CloudManagedGatewayRelayService);
    if (!(service instanceof CloudManagedGatewayRelayService)) {
      throw new Error("Unexpected relay service type");
    }
    expect(service.getSessionInfo().status).toBe("stopped");
    expect(getService).not.toHaveBeenCalled();
  });
});
