/**
 * Exercises hosted message identity, role metadata, and fail-closed runtime
 * behavior through both AgentManager and its authenticated HTTP boundary.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  AgentRuntime,
  type HandlerCallback,
  type IAgentRuntime,
  type IMessageService,
  type Memory,
  type MessageProcessingResult,
  stringToUuid,
} from "@elizaos/core";
import { AgentManager } from "../../src/agent-manager";
import { createRoutes } from "../../src/routes";

interface FakeRuntimeOptions {
  messageService: IMessageService | null;
  ensureConnection?: IAgentRuntime["ensureConnection"];
}

/**
 * Builds a minimal runtime stub sufficient for handleMessage: ensureConnection
 * is a no-op and messageService is injectable (nullable) to model a runtime
 * whose message pipeline failed to initialize.
 */
function makeRuntime(opts: FakeRuntimeOptions): AgentRuntime {
  const runtime = new AgentRuntime({ logLevel: "fatal" });
  runtime.ensureConnection = opts.ensureConnection ?? mock(async () => {});
  runtime.messageService = opts.messageService;
  return runtime;
}

/**
 * Injects a running agent entry into the manager's private registry so
 * getRuntime resolves without a real startAgent (which needs Redis + plugins).
 */
function withRunningAgent(
  manager: AgentManager,
  agentId: string,
  runtime: IAgentRuntime,
): void {
  (
    manager as unknown as {
      agents: Map<string, unknown>;
    }
  ).agents.set(agentId, {
    agentId,
    characterRef: "test:character",
    runtime,
    state: "running",
  });
}

const OK_RESULT: MessageProcessingResult = {
  didRespond: true,
  responseMessages: [],
};

describe("AgentManager.handleMessage fail-closed message pipeline", () => {
  test("throws a structural error when the runtime has no message service", async () => {
    const manager = new AgentManager();
    withRunningAgent(manager, "agent-1", makeRuntime({ messageService: null }));

    await expect(
      manager.handleMessage("agent-1", "user-1", "hello"),
    ).rejects.toThrow(/no message service|not initialized/i);
  });

  test("does not fabricate a reply string when message service is missing", async () => {
    const manager = new AgentManager();
    withRunningAgent(manager, "agent-1", makeRuntime({ messageService: null }));

    let thrown: unknown;
    try {
      await manager.handleMessage("agent-1", "user-1", "hello");
    } catch (err) {
      thrown = err;
    }
    // The old code silently returned "No response generated." here.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("No response generated");
  });

  test("returns accumulated response text from the message pipeline", async () => {
    const manager = new AgentManager();
    const handleMessage = mock(
      async (_rt: IAgentRuntime, _mem: Memory, callback?: HandlerCallback) => {
        await callback?.({ text: "hello " });
        await callback?.({ text: "world" });
        return OK_RESULT;
      },
    );
    withRunningAgent(
      manager,
      "agent-1",
      makeRuntime({
        messageService: { handleMessage } as unknown as IMessageService,
      }),
    );

    const response = await manager.handleMessage("agent-1", "user-1", "hi");
    expect(response).toBe("hello world");
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  test("binds hosted chat to a stable per-user OWNER world used by workflow ownership", async () => {
    const manager = new AgentManager();
    const ensureConnection = mock(async () => {});
    const handleMessage = mock(async () => OK_RESULT);
    const runtime = makeRuntime({
      ensureConnection,
      messageService: { handleMessage } as unknown as IMessageService,
    });
    withRunningAgent(manager, "agent-1", runtime);

    await manager.handleMessage(
      "agent-1",
      "user-1",
      "create a workflow",
      undefined,
      "user-1",
    );

    const ownerId = stringToUuid("user-1");
    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: ownerId,
        worldId: stringToUuid("agent-server:agent-1:cloud:world:user-1"),
        metadata: expect.objectContaining({
          ownership: { ownerId },
          roles: { [ownerId]: "OWNER" },
          roleSources: { [ownerId]: "owner" },
        }),
      }),
    );
    expect(handleMessage.mock.calls[0]?.[1]).toMatchObject({
      entityId: ownerId,
    });
  });

  test("does not grant OWNER to an unlinked connector sender", async () => {
    const manager = new AgentManager();
    const ensureConnection = mock(async () => {});
    const runtime = makeRuntime({
      ensureConnection,
      messageService: {
        handleMessage: mock(async () => OK_RESULT),
      } as unknown as IMessageService,
    });
    withRunningAgent(manager, "agent-1", runtime);

    await manager.handleMessage(
      "agent-1",
      "telegram-user",
      "create a workflow",
      {
        platformName: "telegram",
        chatId: "chat-1",
      },
    );

    const connection = ensureConnection.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(connection.metadata).toMatchObject({
      platformName: "telegram",
      chatId: "chat-1",
    });
    expect(connection.metadata).not.toHaveProperty("ownership");
    expect(connection.metadata).not.toHaveProperty("roles");
  });

  test("does not grant OWNER to a plain internal message without an authenticated user principal", async () => {
    const manager = new AgentManager();
    const ensureConnection = mock(async () => {});
    const runtime = makeRuntime({
      ensureConnection,
      messageService: {
        handleMessage: mock(async () => OK_RESULT),
      } as unknown as IMessageService,
    });
    withRunningAgent(manager, "agent-1", runtime);

    await manager.handleMessage("agent-1", "user-1", "create a workflow");

    const connection = ensureConnection.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(connection.metadata).not.toHaveProperty("ownership");
    expect(connection.metadata).not.toHaveProperty("roles");
  });

  test("namespaces connector identity away from an authenticated Cloud principal with the same raw id", async () => {
    const manager = new AgentManager();
    const ensureConnection = mock(async () => {});
    const runtime = makeRuntime({
      ensureConnection,
      messageService: {
        handleMessage: mock(async () => OK_RESULT),
      } as unknown as IMessageService,
    });
    withRunningAgent(manager, "agent-1", runtime);

    await manager.handleMessage(
      "agent-1",
      "shared-id",
      "owner turn",
      undefined,
      "shared-id",
    );
    await manager.handleMessage("agent-1", "shared-id", "connector turn", {
      platformName: "telegram",
      chatId: "chat-1",
    });

    const ownerConnection = ensureConnection.mock.calls[0]?.[0] as {
      entityId: string;
      roomId: string;
      worldId: string;
    };
    const connectorConnection = ensureConnection.mock.calls[1]?.[0] as {
      entityId: string;
      roomId: string;
      worldId: string;
    };
    expect(connectorConnection.entityId).not.toBe(ownerConnection.entityId);
    expect(connectorConnection.roomId).not.toBe(ownerConnection.roomId);
    expect(connectorConnection.worldId).not.toBe(ownerConnection.worldId);
  });

  test("accepts OWNER identity only from the forwarded Cloud principal header", async () => {
    const manager = new AgentManager();
    const ensureConnection = mock(async () => {});
    const runtime = makeRuntime({
      ensureConnection,
      messageService: {
        handleMessage: mock(async () => OK_RESULT),
      } as unknown as IMessageService,
    });
    withRunningAgent(manager, "agent-1", runtime);
    const app = createRoutes(manager, "server-secret");

    const response = await app.handle(
      new Request("http://agent-server.test/agents/agent-1/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-server-token": "server-secret",
          "x-eliza-user-id": "user-1",
        },
        body: JSON.stringify({ userId: "user-1", text: "create a workflow" }),
      }),
    );

    expect(response.status).toBe(200);
    const connection = ensureConnection.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(connection.metadata).toHaveProperty("roles");
  });

  test("rejects a body identity that disagrees with the forwarded Cloud principal", async () => {
    const manager = new AgentManager();
    const ensureConnection = mock(async () => {});
    const runtime = makeRuntime({
      ensureConnection,
      messageService: {
        handleMessage: mock(async () => OK_RESULT),
      } as unknown as IMessageService,
    });
    withRunningAgent(manager, "agent-1", runtime);
    const app = createRoutes(manager, "server-secret");

    const response = await app.handle(
      new Request("http://agent-server.test/agents/agent-1/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-server-token": "server-secret",
          "x-eliza-user-id": "authenticated-user",
        },
        body: JSON.stringify({
          userId: "spoofed-user",
          text: "create a workflow",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(ensureConnection).not.toHaveBeenCalled();
  });

  test("returns empty string (not a fabricated literal) on a deliberate no-response", async () => {
    const manager = new AgentManager();
    const handleMessage = mock(
      async (): Promise<MessageProcessingResult> => ({
        didRespond: false,
        responseMessages: [],
      }),
    );
    withRunningAgent(
      manager,
      "agent-1",
      makeRuntime({
        messageService: { handleMessage } as unknown as IMessageService,
      }),
    );

    const response = await manager.handleMessage("agent-1", "user-1", "hi");
    // A deliberate silence must be an empty string (adapters drop it), never
    // the old "No response generated." fabrication that read like a reply.
    expect(response).toBe("");
  });

  test("still surfaces getRuntime not-found as its own error (unchanged)", async () => {
    const manager = new AgentManager();
    await expect(
      manager.handleMessage("missing", "user-1", "hi"),
    ).rejects.toThrow("Agent not found");
  });
});
