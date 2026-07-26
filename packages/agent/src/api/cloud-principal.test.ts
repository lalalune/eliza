/**
 * Verifies managed-chat principal attestation, including branded environment
 * aliases used by the same agent runtime under non-elizaOS product shells.
 */

import http from "node:http";
import { Socket } from "node:net";
import { stringToUuid } from "@elizaos/core";
import {
  buildBrandEnvAliases,
  getBootConfig,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canCloudPrincipalReceiveRealtimePayload,
  cloudPrincipalOwnsConversation,
  isCloudPrincipalRequired,
  resolveTrustedCloudPrincipal,
} from "./cloud-principal.ts";
import {
  isWebSocketAuthorized,
  resolveWebSocketUpgradeRejection,
} from "./server-helpers-auth.ts";

const TOUCHED_ENV_KEYS = [
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_API_TOKEN",
  "MILADY_CLOUD_PROVISIONED",
  "MILADY_API_TOKEN",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "MILADY_ALLOW_WS_QUERY_TOKEN",
] as const;

function websocketRequest(
  headers: http.IncomingHttpHeaders,
): http.IncomingMessage {
  const request = new http.IncomingMessage(new Socket());
  request.headers = { ...headers };
  return request;
}

describe("managed Cloud principal attestation", () => {
  const originalConfig = getBootConfig();
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    setBootConfig({
      ...originalConfig,
      envAliases: buildBrandEnvAliases("MILADY"),
    });
  });

  afterEach(() => {
    setBootConfig(originalConfig);
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it("accepts an edge principal using branded managed-container credentials", () => {
    process.env.MILADY_CLOUD_PROVISIONED = "1";
    process.env.MILADY_API_TOKEN = "milady-agent-token";

    expect(isCloudPrincipalRequired()).toBe(true);
    expect(
      resolveTrustedCloudPrincipal({
        headers: {
          "x-eliza-user-id": "cloud-user-1",
          "x-eliza-principal-token": "milady-agent-token",
        },
      }),
    ).toBeTruthy();
    expect(process.env.ELIZA_CLOUD_PROVISIONED).toBeUndefined();
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it('treats the canonical string "true" as a managed Cloud runtime', () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "true";
    process.env.ELIZA_API_TOKEN = "agent-token";

    expect(isCloudPrincipalRequired()).toBe(true);
    expect(
      resolveTrustedCloudPrincipal({
        headers: {
          "x-eliza-user-id": "cloud-user-true",
          "x-eliza-principal-token": "agent-token",
        },
      }),
    ).toBe(stringToUuid("cloud-user-true"));
  });

  it("lets explicit canonical settings override branded aliases", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "0";
    process.env.MILADY_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_API_TOKEN = "canonical-token";
    process.env.MILADY_API_TOKEN = "milady-token";

    expect(isCloudPrincipalRequired()).toBe(false);
    expect(
      resolveTrustedCloudPrincipal({
        headers: {
          "x-eliza-user-id": "cloud-user-1",
          "x-eliza-principal-token": "milady-token",
        },
      }),
    ).toBeNull();
  });

  it("requires the edge-attested principal on a managed WebSocket handshake", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_API_TOKEN = "agent-token";
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    const url = new URL("http://localhost/ws?token=agent-token");
    const missingPrincipal = websocketRequest({});
    const attested = websocketRequest({
      "x-eliza-user-id": "cloud-user-a",
      "x-eliza-principal-token": "agent-token",
    });

    expect(isWebSocketAuthorized(missingPrincipal, url)).toBe(false);
    expect(resolveWebSocketUpgradeRejection(missingPrincipal, url)).toEqual({
      status: 401,
      reason: "Unauthorized",
    });
    expect(isWebSocketAuthorized(attested, url)).toBe(true);
    expect(resolveWebSocketUpgradeRejection(attested, url)).toBeNull();
  });
});

describe("managed Cloud realtime routing", () => {
  const ownerA = stringToUuid("cloud-user-a");
  const ownerB = stringToUuid("cloud-user-b");
  const conversations = [
    {
      id: "conversation-a",
      roomId: stringToUuid("room-a"),
      cloudOwnerEntityId: ownerA,
    },
    {
      id: "conversation-b",
      roomId: stringToUuid("room-b"),
      cloudOwnerEntityId: ownerB,
    },
  ];

  it("routes two sockets only their own room and conversation frames", () => {
    const roomAEvent = {
      type: "agent_event",
      roomId: conversations[0].roomId,
      payload: { text: "private A" },
    };
    const conversationAUpdate = {
      type: "conversation-updated",
      conversation: { id: "conversation-a", title: "Private A" },
    };

    expect(
      canCloudPrincipalReceiveRealtimePayload(
        ownerA,
        conversations,
        roomAEvent,
      ),
    ).toBe(true);
    expect(
      canCloudPrincipalReceiveRealtimePayload(
        ownerB,
        conversations,
        roomAEvent,
      ),
    ).toBe(false);
    expect(
      canCloudPrincipalReceiveRealtimePayload(
        ownerA,
        conversations,
        conversationAUpdate,
      ),
    ).toBe(true);
    expect(
      canCloudPrincipalReceiveRealtimePayload(
        ownerB,
        conversations,
        conversationAUpdate,
      ),
    ).toBe(false);
  });

  it("shares only allowlisted agent status and suppresses unscoped data", () => {
    expect(
      canCloudPrincipalReceiveRealtimePayload(ownerA, conversations, {
        type: "status",
        state: "running",
      }),
    ).toBe(true);
    expect(
      canCloudPrincipalReceiveRealtimePayload(ownerB, conversations, {
        type: "status",
        state: "running",
      }),
    ).toBe(true);
    expect(
      canCloudPrincipalReceiveRealtimePayload(ownerA, conversations, {
        type: "training_event",
        payload: { private: true },
      }),
    ).toBe(false);
    expect(cloudPrincipalOwnsConversation(ownerA, conversations[1])).toBe(
      false,
    );
  });

  it("rejects frames whose room and conversation identifiers disagree", () => {
    const conflictingFrame = {
      type: "agent_event",
      conversationId: conversations[1].id,
      roomId: conversations[0].roomId,
      payload: { text: "must not cross either boundary" },
    };

    expect(
      canCloudPrincipalReceiveRealtimePayload(
        ownerA,
        conversations,
        conflictingFrame,
      ),
    ).toBe(false);
    expect(
      canCloudPrincipalReceiveRealtimePayload(
        ownerB,
        conversations,
        conflictingFrame,
      ),
    ).toBe(false);
  });
});
