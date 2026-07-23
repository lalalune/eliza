/**
 * Proves already-resolved shared bridge callers cannot reach the legacy
 * provider path without a versioned authorization proof and Worker context.
 */

import { describe, expect, mock, test } from "bun:test";

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";
import {
  BRIDGE_CACHE_WARMING_CODE,
  type BridgeExecutionContext,
  type BridgeRequest,
  type BridgeResponse,
  ElizaSandboxService,
} from "../eliza-sandbox";
import type { InferenceAuthorizationProof } from "../inference-authorization-boundary";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000101";
const USER_ID = "00000000-0000-4000-8000-000000000102";

function sharedAgent(): AgentSandbox {
  const now = new Date("2026-07-23T00:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000100",
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    character_id: null,
    sandbox_id: null,
    status: "running",
    execution_tier: "shared",
    bridge_url: null,
    health_url: null,
    agent_name: "Strong shared",
    agent_config: {},
    database_uri: "postgresql://must-not-connect.invalid/agent",
    database_status: "ready",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: {
      ELIZAOS_CLOUD_API_KEY: "eliza_managed_strong_boundary",
    },
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
    image_digest: null,
    previous_image_digest: null,
    previous_docker_image: null,
    billing_status: "active",
    last_billed_at: null,
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: null,
    pool_ready_at: null,
    claimed_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

const RPC: BridgeRequest = {
  jsonrpc: "2.0",
  id: "strong-boundary",
  method: "message.send",
  params: {
    text: "must authorize",
    roomId: "room-strong-boundary",
  },
};

const AUTHORIZATION: InferenceAuthorizationProof = {
  v: 1,
  organizationId: ORGANIZATION_ID,
  organizationRevision: "4",
  userId: USER_ID,
  userRevision: "2",
  credential: {
    kind: "api_key",
    id: "00000000-0000-4000-8000-000000000103",
    fingerprint: "a".repeat(64),
    revision: "3",
    expiresAt: null,
  },
};

interface StrongBridgeHarness {
  bridgeResolvedShared(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<BridgeResponse>;
  bridgeSharedMessageSend: (
    rec: AgentSandbox,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ) => Promise<BridgeResponse>;
  resolveManagedSharedAuthorization: (
    rec: AgentSandbox,
    executionCtx?: BridgeExecutionContext,
  ) => Promise<InferenceAuthorizationProof>;
  sharedConversationCoordinator: () => RuntimeDurableObjectNamespace;
}

describe("ElizaSandboxService strong shared bridge boundary", () => {
  test("missing Worker context fails retryably before the legacy provider path", async () => {
    const service = new ElizaSandboxService() as unknown as StrongBridgeHarness;
    const legacyProviderPath = mock(
      async (): Promise<BridgeResponse> => ({
        jsonrpc: "2.0",
        result: { text: "must never run" },
      }),
    );
    service.bridgeSharedMessageSend = legacyProviderPath;

    const response = await runWithCloudBindingsAsync({ INFERENCE_AUTH_CACHE_ENABLED: "true" }, () =>
      service.bridgeResolvedShared(sharedAgent(), RPC),
    );

    expect(response.error).toMatchObject({
      code: BRIDGE_CACHE_WARMING_CODE,
    });
    expect(legacyProviderPath).not.toHaveBeenCalled();
  });

  test("forwards the immutable proof to the coordinator and never falls back after denial", async () => {
    const service = new ElizaSandboxService() as unknown as StrongBridgeHarness;
    const legacyProviderPath = mock(
      async (): Promise<BridgeResponse> => ({
        jsonrpc: "2.0",
        result: { text: "must never run" },
      }),
    );
    const coordinatorFetch = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ error: "Inference authorization was revoked" }, { status: 503 }),
    );
    service.bridgeSharedMessageSend = legacyProviderPath;
    service.resolveManagedSharedAuthorization = mock(async () => AUTHORIZATION);
    service.sharedConversationCoordinator = () => ({
      getByName: () => ({ fetch: coordinatorFetch }),
    });
    const executionCtx: BridgeExecutionContext = {
      waitUntil() {},
    };

    const response = await runWithCloudBindingsAsync({ INFERENCE_AUTH_CACHE_ENABLED: "true" }, () =>
      service.bridgeResolvedShared(sharedAgent(), RPC, executionCtx),
    );

    expect(response.error).toMatchObject({
      code: BRIDGE_CACHE_WARMING_CODE,
    });
    expect(coordinatorFetch).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(String(coordinatorFetch.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(envelope).toMatchObject({
      operation: "bridge",
      authorization: AUTHORIZATION,
      rpc: RPC,
    });
    expect(legacyProviderPath).not.toHaveBeenCalled();
  });
});
