/**
 * Verifies the scenario activation turn delegates to the production boundary
 * contract and preserves its durable response metadata.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executePostSignInActivationTurn } from "./post-sign-in-activation-turn.ts";

describe("post-sign-in activation scenario turn", () => {
  it("returns the exact production greeting response without synthesizing text", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
    } as unknown as AgentRuntime;
    const ownerId = "00000000-0000-0000-0000-000000000002" as UUID;
    const roomId = "00000000-0000-0000-0000-000000000003" as UUID;
    const ensureActivation = vi.fn(async () => ({
      text: "production activation",
      agentName: "Eliza",
      generated: true,
      persisted: true,
      messageId: "00000000-0000-0000-0000-000000000004",
      source: "agent_greeting" as const,
      timestamp: 1234,
      greetingKind: "post_sign_in_activation" as const,
      activationVersion: "1" as const,
      conversationId: "scenario:activation-proof:main",
    }));

    const result = await executePostSignInActivationTurn({
      runtime,
      ownerId,
      roomId,
      conversationId: "scenario:activation-proof:main",
      ensureActivation,
    });

    expect(ensureActivation).toHaveBeenCalledWith({
      runtime,
      ownerId,
      roomId,
      conversationId: "scenario:activation-proof:main",
    });
    expect(result).toMatchObject({
      responseText: "production activation",
      statusCode: 200,
      responseBody: {
        messageId: "00000000-0000-0000-0000-000000000004",
        source: "agent_greeting",
        greetingKind: "post_sign_in_activation",
        activationVersion: "1",
      },
    });
  });

  it("preserves production retry suppression without reconstructing the greeting", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
    } as unknown as AgentRuntime;
    const ensureActivation = vi.fn(async () => ({
      text: "",
      agentName: "Eliza",
      generated: false,
      persisted: false,
      messageId: "00000000-0000-0000-0000-000000000004",
      source: "agent_greeting" as const,
      timestamp: 1234,
      greetingKind: "post_sign_in_activation" as const,
      activationVersion: "1" as const,
      conversationId: "scenario:activation-proof:main",
    }));

    const result = await executePostSignInActivationTurn({
      runtime,
      ownerId: "00000000-0000-0000-0000-000000000002" as UUID,
      roomId: "00000000-0000-0000-0000-000000000003" as UUID,
      conversationId: "scenario:activation-proof:main",
      ensureActivation,
    });

    expect(result).toMatchObject({
      responseText: "",
      responseBody: {
        generated: false,
        persisted: false,
        messageId: "00000000-0000-0000-0000-000000000004",
      },
    });
  });
});
