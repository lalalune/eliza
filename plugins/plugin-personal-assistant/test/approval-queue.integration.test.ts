/**
 * Approval queue integration test (WS6).
 *
 * Drives the real `PgApprovalQueue` against a PGlite-backed runtime.
 * Exercises:
 *   - enqueue → approve → markExecuting → markDone (happy path)
 *   - enqueue → reject
 *   - enqueue (expired in past) → purgeExpired → markExpired noop rejected
 *   - invalid transitions throw ApprovalStateTransitionError
 *
 * Run: bunx vitest run eliza/plugins/plugin-personal-assistant/test/approval-queue.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeGraphService, knowledgeGraphSchema } from "@elizaos/agent";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { AgentEventService, parseInteractionBlocks } from "@elizaos/core";
import { schedulingPlugin } from "@elizaos/plugin-scheduling";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRealTestRuntime } from "../../../packages/test/helpers/real-runtime.ts";
import { runSchedulingNegotiationHandler } from "../src/actions/lib/scheduling-handler.js";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import {
  type ApprovalEnqueueInput,
  ApprovalNotFoundError,
  type ApprovalQueue,
  ApprovalStateTransitionError,
} from "../src/lifeops/approval-queue.types.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import {
  attachSchedulingApprovalCorrelation,
  readSchedulingApprovalCorrelation,
  verifySchedulingApprovalContent,
} from "../src/lifeops/scheduling-approval.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { personalAssistantPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let queue: ApprovalQueue;
let isolatedStateDir: string;
let isolatedConfigPath: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

const knowledgeGraphPlugin: Plugin = {
  name: "approval-queue-knowledge-graph",
  description: "Contact graph required by scheduling draft resolution.",
  schema: knowledgeGraphSchema,
  services: [KnowledgeGraphService],
};

function setIsolatedEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "approval-queue-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );
  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }
  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
  delete process.env.ELIZA_STATE_DIR;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
}

function restoreEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function messageInput(
  overrides: Partial<ApprovalEnqueueInput> = {},
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-123",
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "+15555551212",
      body: "Hello!",
      replyToMessageId: null,
    },
    channel: "sms",
    reason: "agent wants to confirm before sending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

beforeAll(async () => {
  setIsolatedEnv();
  const result = await createRealTestRuntime({
    plugins: [knowledgeGraphPlugin, schedulingPlugin, personalAssistantPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
  // The enqueue chat-post (#14733) resolves the agent-event service off the
  // runtime; register the real one when the test runtime lacks it. Service
  // registration is lazy, so force the start (the agent server does the same
  // at boot when the WS bridge subscribes).
  if (!runtime.getService(AgentEventService.serviceType)) {
    await runtime.registerService(AgentEventService);
    await runtime.getServiceLoadPromise(AgentEventService.serviceType);
  }
  queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreEnv();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe("ApprovalQueue integration (real PGlite)", () => {
  it("enqueue → approve → markExecuting → markDone happy path", async () => {
    const enqueued = await queue.enqueue(messageInput());
    expect(enqueued.state).toBe("pending");
    expect(enqueued.resolvedAt).toBeNull();
    expect(enqueued.resolvedBy).toBeNull();

    const fetched = await queue.byId(enqueued.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.action).toBe("send_message");

    const approved = await queue.approve(enqueued.id, {
      resolvedBy: "owner-123",
      resolutionReason: "looks good",
    });
    expect(approved.state).toBe("approved");
    expect(approved.resolvedBy).toBe("owner-123");
    expect(approved.resolvedAt).toBeInstanceOf(Date);

    const executing = await queue.markExecuting(enqueued.id);
    expect(executing.state).toBe("executing");

    const done = await queue.markDone(enqueued.id);
    expect(done.state).toBe("done");

    const pendingList = await queue.list({
      subjectUserId: "owner-123",
      state: "pending",
      action: null,
      limit: 10,
    });
    expect(pendingList.every((r) => r.id !== enqueued.id)).toBe(true);
  }, 60_000);

  it("round-trips an exact scheduling draft and typed content hash through the real queue", async () => {
    const payload = attachSchedulingApprovalCorrelation(
      {
        action: "send_email",
        to: ["co-parent@example.com"],
        cc: [],
        bcc: [],
        subject: "Scheduling: school conference",
        body: "Would Tuesday at 4:00 PM work for the school conference?",
        threadId: null,
        replyToMessageId: null,
      },
      {
        kind: "scheduling_message",
        negotiationId: "negotiation-17",
        proposalId: "proposal-41",
        messageKind: "proposal",
        transportChannel: "email",
        sourceUpdatedAt: "2026-07-26T18:30:00.000Z",
        draftVersion: 1,
      },
    );
    const enqueued = await queue.enqueue({
      requestedBy: "PERSONAL_ASSISTANT",
      subjectUserId: "owner-scheduling-integrity",
      action: "send_email",
      payload,
      channel: "email",
      reason: "Review exact scheduling proposal",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const fetched = await queue.byId(enqueued.id);
    if (!fetched) throw new Error("approval row disappeared after enqueue");
    expect(fetched.payload).toEqual(payload);
    expect(readSchedulingApprovalCorrelation(fetched.payload)).toMatchObject({
      negotiationId: "negotiation-17",
      proposalId: "proposal-41",
      messageKind: "proposal",
      transportChannel: "email",
    });
    expect(verifySchedulingApprovalContent(fetched.payload)).toMatchObject({
      matches: true,
      actualSha256: payload.scheduling.contentSha256,
    });
  }, 60_000);

  it("scheduling start/propose/finalize/cancel queue exact drafts without connector delivery", async () => {
    const service = new LifeOpsService(runtime);
    const counterparty = await service.upsertRelationship({
      name: "Taylor",
      primaryChannel: "email",
      primaryHandle: "co-parent@example.com",
      email: "co-parent@example.com",
      phone: null,
      notes: "co-parent",
      tags: ["family"],
      relationshipType: "co_parent_of",
      lastContactedAt: null,
      metadata: {},
    });
    const sendEmail = vi.spyOn(LifeOpsService.prototype, "sendGmailMessage");
    const message = {
      id: runtime.agentId,
      entityId: runtime.agentId,
      roomId: runtime.agentId,
      content: { text: "Coordinate the school conference with Taylor" },
    } as never;

    const result = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "start",
          subject: "School conference",
          relationshipId: counterparty.id,
          durationMinutes: 30,
          timezone: "America/Los_Angeles",
        },
      } as never,
      async () => [],
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventCreated: false,
      },
    });
    const data = result.data as {
      negotiation: { id: string };
      approvalRequestId: string;
    };
    const approval = await queue.byId(data.approvalRequestId);
    if (!approval) throw new Error("scheduling handler queued no approval");
    expect(approval.state).toBe("pending");
    expect(approval.action).toBe("send_email");
    expect(approval.payload).toMatchObject({
      action: "send_email",
      to: ["co-parent@example.com"],
      subject: "Scheduling: School conference",
    });
    expect(approval.reason).toContain("To: Taylor (co-parent@example.com)");
    expect(approval.reason).toContain("Subject: Scheduling: School conference");
    expect(approval.reason).toContain("Message:\nHi,");
    expect(approval.reason).toContain("Content SHA-256:");
    expect(readSchedulingApprovalCorrelation(approval.payload)).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: null,
      messageKind: "opening",
      transportChannel: "email",
    });
    expect(verifySchedulingApprovalContent(approval.payload)?.matches).toBe(
      true,
    );

    const proposed = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "propose",
          negotiationId: data.negotiation.id,
          startAt: "2026-08-10T23:00:00.000Z",
          endAt: "2026-08-10T23:30:00.000Z",
          proposedBy: "owner",
        },
      } as never,
      async () => [],
    );
    expect(proposed).toMatchObject({
      success: true,
      data: {
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventCreated: false,
      },
    });
    const proposedData = proposed.data as {
      proposal: { id: string };
      approvalRequestId: string;
    };
    const proposalApproval = await queue.byId(proposedData.approvalRequestId);
    if (!proposalApproval) {
      throw new Error("proposal handler queued no approval");
    }
    expect(
      readSchedulingApprovalCorrelation(proposalApproval.payload),
    ).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: proposedData.proposal.id,
      messageKind: "proposal",
    });
    expect(
      verifySchedulingApprovalContent(proposalApproval.payload)?.matches,
    ).toBe(true);

    const responded = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "respond",
          proposalId: proposedData.proposal.id,
          response: "accepted",
        },
      } as never,
      async () => [],
    );
    expect(responded).toMatchObject({
      success: true,
      data: { proposal: { status: "accepted" } },
    });

    const finalized = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "finalize",
          negotiationId: data.negotiation.id,
          proposalId: proposedData.proposal.id,
        },
      } as never,
      async () => [],
    );
    expect(finalized).toMatchObject({
      success: true,
      data: {
        negotiation: {
          state: "confirmed",
          acceptedProposalId: proposedData.proposal.id,
        },
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventCreated: false,
      },
    });
    const finalizedData = finalized.data as { approvalRequestId: string };
    const confirmationApproval = await queue.byId(
      finalizedData.approvalRequestId,
    );
    if (!confirmationApproval) {
      throw new Error("finalize handler queued no approval");
    }
    expect(
      readSchedulingApprovalCorrelation(confirmationApproval.payload),
    ).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: proposedData.proposal.id,
      messageKind: "confirmation",
    });
    expect(
      verifySchedulingApprovalContent(confirmationApproval.payload)?.matches,
    ).toBe(true);

    const cancelled = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "cancel",
          negotiationId: data.negotiation.id,
          reason: "Conference moved to a school-managed booking portal",
        },
      } as never,
      async () => [],
    );
    expect(cancelled).toMatchObject({
      success: true,
      data: {
        negotiation: { state: "cancelled" },
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventChanged: false,
      },
    });
    const cancelledData = cancelled.data as { approvalRequestId: string };
    const cancellationApproval = await queue.byId(
      cancelledData.approvalRequestId,
    );
    if (!cancellationApproval) {
      throw new Error("cancel handler queued no approval");
    }
    expect(
      readSchedulingApprovalCorrelation(cancellationApproval.payload),
    ).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: proposedData.proposal.id,
      messageKind: "cancellation",
    });
    expect(
      verifySchedulingApprovalContent(cancellationApproval.payload)?.matches,
    ).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  }, 60_000);

  it("enqueue posts the question into chat as an assistant event with approve/reject chips (#14733)", async () => {
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const eventService = runtime.getService(
      AgentEventService.serviceType,
    ) as AgentEventService;
    const unsubscribe = eventService.subscribe((event) => {
      events.push({ stream: event.stream, data: event.data });
    });
    try {
      const enqueued = await queue.enqueue(
        messageInput({ subjectUserId: "owner-chips" }),
      );

      const assistant = events.filter(
        (event) =>
          event.stream === "assistant" &&
          event.data.source === "lifeops-approval",
      );
      expect(assistant).toHaveLength(1);
      const data = assistant[0]?.data ?? {};
      expect(data.requestId).toBe(enqueued.id);
      expect(data.action).toBe("send_message");
      const text = String(data.text ?? "");
      expect(text).toContain("agent wants to confirm before sending");
      const { blocks } = parseInteractionBlocks(text);
      expect(blocks).toHaveLength(1);
      const block = blocks[0];
      if (block?.kind !== "choice") throw new Error("expected choice block");
      expect(block.scope).toBe(`approval-${enqueued.id}`);
      expect(block.id).toBe(enqueued.id);
      // The tapped value is the owner's next message; it must carry the id
      // RESOLVE_REQUEST resolves verbatim.
      expect(block.options.map((o) => o.value)).toEqual([
        `approve ${enqueued.id}`,
        `reject ${enqueued.id}`,
      ]);

      // Round-trip: drive the queue with the tapped approve value's id.
      const tapped = block.options[0]?.value ?? "";
      const requestId = tapped.replace(/^approve /, "");
      const approved = await queue.approve(requestId, {
        resolvedBy: "owner-chips",
        resolutionReason: "tapped Approve",
      });
      expect(approved.id).toBe(enqueued.id);
      expect(approved.state).toBe("approved");
    } finally {
      unsubscribe();
    }
  }, 60_000);

  it("enqueue creates an owner-visible approval ScheduledTask for connector escalation (#14722)", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-scheduled-task" }),
    );

    const repo = new LifeOpsRepository(runtime);
    const task = await repo.getScheduledTaskByIdempotencyKey(
      runtime.agentId,
      `approval:${enqueued.id}`,
    );

    expect(task).not.toBeNull();
    expect(task?.kind).toBe("approval");
    expect(task?.priority).toBe("high");
    expect(task?.ownerVisible).toBe(true);
    expect(task?.respectsGlobalPause).toBe(false);
    expect(task?.subject).toEqual({
      kind: "self",
      id: "owner-scheduled-task",
    });
    expect(task?.metadata?.approvalRequestId).toBe(enqueued.id);
    expect(task?.metadata?.approvalAction).toBe("send_message");
    expect(task?.metadata?.pendingPromptRoomId).toBe(`approval:${enqueued.id}`);
    expect(task?.completionCheck?.kind).toBe("user_acknowledged");
    expect(task?.completionCheck?.params).toEqual({ requestId: enqueued.id });
    expect(task?.escalation?.steps?.map((step) => step.channelKey)).toEqual(
      expect.arrayContaining(["sms", "telegram", "discord", "imessage"]),
    );
    expect(task?.escalation?.steps?.at(-1)?.channelKey).toBe("in_app");
    expect(task?.promptInstructions).toContain(`approve ${enqueued.id}`);
    expect(task?.promptInstructions).toContain(`reject ${enqueued.id}`);
  }, 60_000);

  it("rolls back the approval row when the ScheduledTask cannot be created", async () => {
    const failedStateDir = mkdtempSync(
      join(tmpdir(), "approval-queue-schedule-fail-"),
    );
    const failedConfigPath = join(failedStateDir, "eliza.json");
    writeFileSync(
      failedConfigPath,
      JSON.stringify({ logging: { level: "error" } }),
      "utf8",
    );
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousConfigPath = process.env.ELIZA_CONFIG_PATH;
    const previousPersistConfigPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
    process.env.ELIZA_STATE_DIR = failedStateDir;
    process.env.ELIZA_CONFIG_PATH = failedConfigPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = failedConfigPath;
    let failedCleanup: (() => Promise<void>) | null = null;
    try {
      const result = await createRealTestRuntime({
        plugins: [personalAssistantPlugin],
      });
      failedCleanup = result.cleanup;
      const failedQueue = createApprovalQueue(result.runtime, {
        agentId: result.runtime.agentId,
      });

      await expect(
        failedQueue.enqueue(
          messageInput({ subjectUserId: "owner-schedule-fail" }),
        ),
      ).rejects.toThrow("failed to schedule approval task");

      await expect(
        failedQueue.list({
          subjectUserId: "owner-schedule-fail",
          state: null,
          action: null,
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await failedCleanup?.();
      if (previousStateDir === undefined) {
        delete process.env.ELIZA_STATE_DIR;
      } else {
        process.env.ELIZA_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.ELIZA_CONFIG_PATH;
      } else {
        process.env.ELIZA_CONFIG_PATH = previousConfigPath;
      }
      if (previousPersistConfigPath === undefined) {
        delete process.env.ELIZA_PERSIST_CONFIG_PATH;
      } else {
        process.env.ELIZA_PERSIST_CONFIG_PATH = previousPersistConfigPath;
      }
      rmSync(failedStateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("enqueue → reject records resolver", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-reject" }),
    );
    const rejected = await queue.reject(enqueued.id, {
      resolvedBy: "owner-reject",
      resolutionReason: "not now",
    });
    expect(rejected.state).toBe("rejected");
    expect(rejected.resolutionReason).toBe("not now");
  }, 60_000);

  it("purgeExpired moves past-due pending rows to expired", async () => {
    const pastExpiry = new Date(Date.now() - 5 * 60 * 1000);
    const enqueued = await queue.enqueue(
      messageInput({
        subjectUserId: "owner-expire",
        expiresAt: pastExpiry,
      }),
    );
    const purgedIds = await queue.purgeExpired(new Date());
    expect(purgedIds).toContain(enqueued.id);
    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("expired");
  }, 60_000);

  it("rejects invalid state transitions hard", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-invalid" }),
    );
    // pending -> executing is not allowed; must go through approved first
    await expect(queue.markExecuting(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
    // pending -> done is not allowed
    await expect(queue.markDone(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
  }, 60_000);

  it("throws ApprovalNotFoundError on unknown id", async () => {
    await expect(
      queue.approve("00000000-0000-0000-0000-000000000000", {
        resolvedBy: "owner-123",
        resolutionReason: "x",
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  }, 60_000);
});
