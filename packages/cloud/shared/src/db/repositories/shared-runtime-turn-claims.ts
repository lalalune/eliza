/**
 * Serializes stable-id shared-runtime turns across Worker isolates.
 *
 * A short database transaction claims one queued turn, model inference runs
 * outside the transaction, and completion atomically writes transcript,
 * activation-goal state, and the cached reply. The lease is recovery metadata;
 * ordinary concurrent requests remain strictly one-at-a-time per channel.
 */

import { ElizaError } from "@elizaos/core";
import {
  FTU_GOAL_CONFIDENCE_THRESHOLD,
  type FtuGoalDiscoveryOutput,
} from "@elizaos/shared/contracts";
import { and, asc, eq, lt, lte, ne } from "drizzle-orm";
import { dbWrite } from "../client";
import {
  type AgentActivationGreeting,
  agentActivationGreetings,
} from "../schemas/agent-activation-greetings";
import {
  type SharedRuntimeHistoryMessage,
  sharedRuntimeHistory,
} from "../schemas/shared-runtime-history";
import {
  type SharedRuntimeTurnClaim,
  sharedRuntimeTurnClaims,
} from "../schemas/shared-runtime-turn-claims";
import { jsonbParam } from "../utils/jsonb";

export interface SharedRuntimeTurnClaimInput {
  agentId: string;
  channelId: string;
  clientMessageId: string;
  assistantMessageId: string;
  ownerText: string;
  claimToken: string;
  leaseMs: number;
}

export type SharedRuntimeTurnClaimResult =
  | {
      status: "claimed";
      claimToken: string;
      history: SharedRuntimeHistoryMessage[];
    }
  | { status: "handoff-fenced"; retryAfterMs: number }
  | { status: "waiting" }
  | { status: "completed"; assistantReply: string };

export interface SharedRuntimeTurnActivationCompletion {
  ownerUserId: string;
  activationVersion: string;
  extraction: FtuGoalDiscoveryOutput;
  extractionModel: string;
}

export interface CompleteSharedRuntimeTurnInput {
  agentId: string;
  channelId: string;
  clientMessageId: string;
  assistantMessageId: string;
  ownerText: string;
  assistantText: string;
  ownerCreatedAt: number;
  assistantCreatedAt: number;
  claimToken: string;
  maxMessages: number;
  activation?: SharedRuntimeTurnActivationCompletion;
}

export interface CompleteSharedRuntimeTurnResult {
  assistantReply: string;
  persisted: boolean;
}

export type SharedRuntimeHandoffSnapshotResult =
  | { ready: false; retryAfterMs: number }
  | {
      ready: true;
      messages: SharedRuntimeHistoryMessage[];
      activation?: AgentActivationGreeting;
    };

function validateLease(leaseMs: number): void {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000) {
    throw new ElizaError("Shared runtime turn lease must be at least one second", {
      code: "INVALID_SHARED_TURN_LEASE",
      context: { leaseMs },
      severity: "ephemeral",
    });
  }
}

function validateHistoryWindow(maxMessages: number): void {
  if (!Number.isInteger(maxMessages) || maxMessages < 2) {
    throw new ElizaError("Shared runtime turn history window must hold a complete pair", {
      code: "INVALID_SHARED_TURN_HISTORY_WINDOW",
      context: { maxMessages },
      severity: "ephemeral",
    });
  }
}

function assertSameTurn(
  claim: SharedRuntimeTurnClaim,
  input: Pick<
    SharedRuntimeTurnClaimInput,
    "agentId" | "channelId" | "clientMessageId" | "assistantMessageId" | "ownerText"
  >,
): void {
  if (
    claim.agent_id !== input.agentId ||
    claim.channel_id !== input.channelId ||
    claim.client_message_id !== input.clientMessageId ||
    claim.assistant_message_id !== input.assistantMessageId ||
    claim.owner_text !== input.ownerText
  ) {
    throw new ElizaError("A shared turn id was reused with different request content", {
      code: "SHARED_TURN_IDEMPOTENCY_CONFLICT",
      context: {
        agentId: input.agentId,
        channelId: input.channelId,
        clientMessageId: input.clientMessageId,
      },
      severity: "fatal",
    });
  }
}

export class SharedRuntimeTurnClaimsRepository {
  /**
   * Claim the next turn for a channel, or observe the winner of a retry.
   *
   * The history-row lock is the channel coordinator. It keeps queue promotion,
   * activation projection, and transcript completion in one global order even
   * when requests land in different Cloudflare Worker isolates.
   */
  async acquire(input: SharedRuntimeTurnClaimInput): Promise<SharedRuntimeTurnClaimResult> {
    validateLease(input.leaseMs);
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    const staleBefore = new Date(now.getTime() - input.leaseMs);

    return await dbWrite.transaction(async (tx) => {
      await tx
        .insert(sharedRuntimeHistory)
        .values({
          agent_id: input.agentId,
          channel_id: input.channelId,
          messages: jsonbParam([]),
          updated_at: now,
        })
        .onConflictDoNothing({
          target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        });

      const [historyRow] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, input.agentId),
            eq(sharedRuntimeHistory.channel_id, input.channelId),
          ),
        )
        .for("update")
        .limit(1);
      if (!historyRow) {
        throw new ElizaError("Shared history coordinator row vanished during turn claim", {
          code: "SHARED_TURN_HISTORY_MISSING",
          context: { agentId: input.agentId, channelId: input.channelId },
          severity: "fatal",
        });
      }

      if (
        historyRow.handoff_fence_token &&
        historyRow.handoff_fence_expires_at &&
        historyRow.handoff_fence_expires_at.getTime() > now.getTime()
      ) {
        return {
          status: "handoff-fenced",
          retryAfterMs: Math.max(1, historyRow.handoff_fence_expires_at.getTime() - now.getTime()),
        };
      }
      if (historyRow.handoff_fence_token || historyRow.handoff_fence_expires_at) {
        await tx
          .update(sharedRuntimeHistory)
          .set({
            handoff_fence_token: null,
            handoff_fence_expires_at: null,
            updated_at: now,
          })
          .where(
            and(
              eq(sharedRuntimeHistory.agent_id, input.agentId),
              eq(sharedRuntimeHistory.channel_id, input.channelId),
            ),
          );
      }

      // A browser that disappeared while queued must not permanently block all
      // later conversation turns. Processing rows are handled below because a
      // same-id retry can safely take over their expired lease.
      await tx
        .delete(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.state, "queued"),
            lt(sharedRuntimeTurnClaims.updated_at, staleBefore),
          ),
        );

      await tx
        .insert(sharedRuntimeTurnClaims)
        .values({
          agent_id: input.agentId,
          channel_id: input.channelId,
          client_message_id: input.clientMessageId,
          assistant_message_id: input.assistantMessageId,
          owner_text: input.ownerText,
          state: "queued",
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing({
          target: [
            sharedRuntimeTurnClaims.agent_id,
            sharedRuntimeTurnClaims.channel_id,
            sharedRuntimeTurnClaims.client_message_id,
          ],
        });

      const [claim] = await tx
        .select()
        .from(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.client_message_id, input.clientMessageId),
          ),
        )
        .for("update")
        .limit(1);
      if (!claim) {
        throw new ElizaError("Shared turn claim vanished after insert", {
          code: "SHARED_TURN_CLAIM_MISSING",
          context: {
            agentId: input.agentId,
            channelId: input.channelId,
            clientMessageId: input.clientMessageId,
          },
          severity: "fatal",
        });
      }
      assertSameTurn(claim, input);

      if (claim.state === "completed") {
        if (!claim.assistant_text?.trim()) {
          throw new ElizaError("Completed shared turn is missing its cached reply", {
            code: "SHARED_TURN_COMPLETED_REPLY_MISSING",
            context: {
              agentId: input.agentId,
              channelId: input.channelId,
              clientMessageId: input.clientMessageId,
            },
            severity: "fatal",
          });
        }
        return { status: "completed", assistantReply: claim.assistant_text };
      }

      if (claim.state === "processing") {
        if (claim.claim_token === input.claimToken) {
          return {
            status: "claimed",
            claimToken: input.claimToken,
            history: Array.isArray(historyRow.messages) ? historyRow.messages : [],
          };
        }
        if (claim.lease_expires_at && claim.lease_expires_at.getTime() <= now.getTime()) {
          const [reclaimed] = await tx
            .update(sharedRuntimeTurnClaims)
            .set({
              claim_token: input.claimToken,
              lease_expires_at: leaseExpiresAt,
              updated_at: now,
            })
            .where(
              and(
                eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
                eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
                eq(sharedRuntimeTurnClaims.client_message_id, input.clientMessageId),
                eq(sharedRuntimeTurnClaims.state, "processing"),
              ),
            )
            .returning();
          if (!reclaimed) {
            throw new ElizaError("Expired shared turn lease could not be reclaimed", {
              code: "SHARED_TURN_RECLAIM_FAILED",
              context: {
                agentId: input.agentId,
                channelId: input.channelId,
                clientMessageId: input.clientMessageId,
              },
              severity: "fatal",
            });
          }
          return {
            status: "claimed",
            claimToken: input.claimToken,
            history: Array.isArray(historyRow.messages) ? historyRow.messages : [],
          };
        }
        return { status: "waiting" };
      }

      const [processing] = await tx
        .select()
        .from(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.state, "processing"),
          ),
        )
        .limit(1);
      if (processing) {
        if (processing.lease_expires_at && processing.lease_expires_at.getTime() <= now.getTime()) {
          // No same-id retry arrived to reclaim this abandoned request. Remove
          // it so an unrelated live turn can advance; a later retry recreates
          // the exact stable-id job and remains idempotent.
          await tx
            .delete(sharedRuntimeTurnClaims)
            .where(
              and(
                eq(sharedRuntimeTurnClaims.agent_id, processing.agent_id),
                eq(sharedRuntimeTurnClaims.channel_id, processing.channel_id),
                eq(sharedRuntimeTurnClaims.client_message_id, processing.client_message_id),
                eq(sharedRuntimeTurnClaims.state, "processing"),
              ),
            );
        } else {
          return { status: "waiting" };
        }
      }

      const [next] = await tx
        .select()
        .from(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.state, "queued"),
          ),
        )
        .orderBy(
          asc(sharedRuntimeTurnClaims.created_at),
          asc(sharedRuntimeTurnClaims.client_message_id),
        )
        .limit(1);
      if (!next || next.client_message_id !== input.clientMessageId) {
        return { status: "waiting" };
      }

      const [claimed] = await tx
        .update(sharedRuntimeTurnClaims)
        .set({
          state: "processing",
          claim_token: input.claimToken,
          lease_expires_at: leaseExpiresAt,
          updated_at: now,
        })
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.client_message_id, input.clientMessageId),
            eq(sharedRuntimeTurnClaims.state, "queued"),
          ),
        )
        .returning();
      if (!claimed) {
        return { status: "waiting" };
      }
      return {
        status: "claimed",
        claimToken: input.claimToken,
        history: Array.isArray(historyRow.messages) ? historyRow.messages : [],
      };
    });
  }

  /** Commit a claimed turn and optional activation-goal extraction atomically. */
  async complete(input: CompleteSharedRuntimeTurnInput): Promise<CompleteSharedRuntimeTurnResult> {
    validateHistoryWindow(input.maxMessages);
    const ownerText = input.ownerText.trim();
    const assistantText = input.assistantText.trim();
    if (!ownerText || !assistantText) {
      throw new ElizaError("A completed shared turn requires non-empty text", {
        code: "SHARED_TURN_COMPLETION_TEXT_MISSING",
        context: {
          agentId: input.agentId,
          channelId: input.channelId,
          clientMessageId: input.clientMessageId,
        },
        severity: "ephemeral",
      });
    }

    return await dbWrite.transaction(async (tx) => {
      let lockedActivation: typeof agentActivationGreetings.$inferSelect | undefined;
      if (input.activation) {
        [lockedActivation] = await tx
          .select()
          .from(agentActivationGreetings)
          .where(
            and(
              eq(agentActivationGreetings.agent_id, input.agentId),
              eq(agentActivationGreetings.owner_user_id, input.activation.ownerUserId),
              eq(agentActivationGreetings.activation_version, input.activation.activationVersion),
            ),
          )
          .for("update")
          .limit(1);
        if (!lockedActivation || lockedActivation.projected_at === null) {
          throw new ElizaError("Activation-goal turn arrived before its greeting was projected", {
            code: "ACTIVATION_RESPONSE_WITHOUT_GREETING",
            context: {
              agentId: input.agentId,
              ownerUserId: input.activation.ownerUserId,
              activationVersion: input.activation.activationVersion,
            },
            severity: "ephemeral",
          });
        }
      }

      const [historyRow] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, input.agentId),
            eq(sharedRuntimeHistory.channel_id, input.channelId),
          ),
        )
        .for("update")
        .limit(1);
      if (!historyRow) {
        throw new ElizaError("Shared history vanished before turn completion", {
          code: "SHARED_TURN_HISTORY_MISSING",
          context: { agentId: input.agentId, channelId: input.channelId },
          severity: "fatal",
        });
      }

      const [claim] = await tx
        .select()
        .from(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.client_message_id, input.clientMessageId),
          ),
        )
        .for("update")
        .limit(1);
      if (!claim) {
        throw new ElizaError("Shared turn claim vanished before completion", {
          code: "SHARED_TURN_CLAIM_MISSING",
          context: {
            agentId: input.agentId,
            channelId: input.channelId,
            clientMessageId: input.clientMessageId,
          },
          severity: "fatal",
        });
      }
      assertSameTurn(claim, {
        agentId: input.agentId,
        channelId: input.channelId,
        clientMessageId: input.clientMessageId,
        assistantMessageId: input.assistantMessageId,
        ownerText,
      });

      if (claim.state === "completed") {
        if (!claim.assistant_text?.trim()) {
          throw new ElizaError("Completed shared turn is missing its cached reply", {
            code: "SHARED_TURN_COMPLETED_REPLY_MISSING",
            context: {
              agentId: input.agentId,
              channelId: input.channelId,
              clientMessageId: input.clientMessageId,
            },
            severity: "fatal",
          });
        }
        return { assistantReply: claim.assistant_text, persisted: false };
      }
      if (claim.state !== "processing" || claim.claim_token !== input.claimToken) {
        throw new ElizaError("Shared turn completion no longer owns the processing lease", {
          code: "SHARED_TURN_CLAIM_LOST",
          context: {
            agentId: input.agentId,
            channelId: input.channelId,
            clientMessageId: input.clientMessageId,
          },
          severity: "ephemeral",
        });
      }

      const ownerMessage: SharedRuntimeHistoryMessage = {
        id: input.clientMessageId,
        role: "user",
        content: ownerText,
        createdAt: input.ownerCreatedAt,
      };
      const assistantMessage: SharedRuntimeHistoryMessage = {
        id: input.assistantMessageId,
        role: "assistant",
        content: assistantText,
        createdAt: input.assistantCreatedAt,
      };
      const current = Array.isArray(historyRow.messages) ? historyRow.messages : [];
      const conflict = current.find(
        (message) =>
          message.id === input.clientMessageId || message.id === input.assistantMessageId,
      );
      if (conflict) {
        throw new ElizaError("Shared transcript already contains a claimed turn id", {
          code: "SHARED_TURN_HISTORY_CONFLICT",
          context: {
            agentId: input.agentId,
            channelId: input.channelId,
            clientMessageId: input.clientMessageId,
            conflictId: conflict.id,
          },
          severity: "fatal",
        });
      }
      const combined = [...current, ownerMessage, assistantMessage];
      const capped =
        combined.length > input.maxMessages
          ? combined.slice(combined.length - input.maxMessages)
          : combined;
      await tx
        .update(sharedRuntimeHistory)
        .set({ messages: jsonbParam(capped), updated_at: new Date() })
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, input.agentId),
            eq(sharedRuntimeHistory.channel_id, input.channelId),
          ),
        );

      if (input.activation) {
        if (!lockedActivation) {
          throw new ElizaError("Activation lock vanished during shared turn completion", {
            code: "ACTIVATION_RESPONSE_LOCK_MISSING",
            context: {
              agentId: input.agentId,
              ownerUserId: input.activation.ownerUserId,
              activationVersion: input.activation.activationVersion,
            },
            severity: "fatal",
          });
        }
        if (lockedActivation.goal_status !== "accepted") {
          const accepted =
            input.activation.extraction.goalFound &&
            input.activation.extraction.goal.trim().length > 0 &&
            input.activation.extraction.confidence >= FTU_GOAL_CONFIDENCE_THRESHOLD;
          await tx
            .update(agentActivationGreetings)
            .set({
              response_message_id: input.clientMessageId,
              response_text: ownerText,
              response_created_at: new Date(input.ownerCreatedAt),
              goal_status: accepted ? "accepted" : "pending",
              goal_text: accepted ? input.activation.extraction.goal.trim() : null,
              goal_confidence: accepted ? input.activation.extraction.confidence : null,
              goal_model: accepted ? input.activation.extractionModel : null,
              goal_recorded_at: accepted ? new Date() : null,
            })
            .where(
              and(
                eq(agentActivationGreetings.agent_id, input.agentId),
                eq(agentActivationGreetings.owner_user_id, input.activation.ownerUserId),
                eq(agentActivationGreetings.activation_version, input.activation.activationVersion),
              ),
            );
        }
      }

      const [completed] = await tx
        .update(sharedRuntimeTurnClaims)
        .set({
          state: "completed",
          claim_token: null,
          lease_expires_at: null,
          assistant_text: assistantText,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.client_message_id, input.clientMessageId),
            eq(sharedRuntimeTurnClaims.state, "processing"),
            eq(sharedRuntimeTurnClaims.claim_token, input.claimToken),
          ),
        )
        .returning();
      if (!completed) {
        throw new ElizaError("Shared turn completion lost its claim during commit", {
          code: "SHARED_TURN_CLAIM_LOST",
          context: {
            agentId: input.agentId,
            channelId: input.channelId,
            clientMessageId: input.clientMessageId,
          },
          severity: "ephemeral",
        });
      }
      return { assistantReply: assistantText, persisted: true };
    });
  }

  /**
   * Remove an unfinished claim owned by this request.
   *
   * Deleting instead of re-queueing prevents a failed request with no live
   * waiter from blocking later turns. A retry recreates the same stable job.
   */
  async abandon(input: {
    agentId: string;
    channelId: string;
    clientMessageId: string;
    claimToken: string;
  }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [historyRow] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, input.agentId),
            eq(sharedRuntimeHistory.channel_id, input.channelId),
          ),
        )
        .for("update")
        .limit(1);
      if (!historyRow) return false;
      const deleted = await tx
        .delete(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.client_message_id, input.clientMessageId),
            eq(sharedRuntimeTurnClaims.state, "processing"),
            eq(sharedRuntimeTurnClaims.claim_token, input.claimToken),
          ),
        )
        .returning({ clientMessageId: sharedRuntimeTurnClaims.client_message_id });
      return deleted.length === 1;
    });
  }

  /**
   * Fence a quiescent channel and return its transcript plus activation row.
   *
   * The fence and snapshot share the history-row lock used by turn admission
   * and completion. A turn already admitted makes the snapshot retry; a turn
   * arriving after the fence receives `handoff-fenced` and cannot be lost
   * between copy and client switch.
   */
  async beginHandoffSnapshot(input: {
    agentId: string;
    channelId: string;
    ownerUserId: string;
    activationVersion: string;
    fenceToken: string;
    leaseMs: number;
  }): Promise<SharedRuntimeHandoffSnapshotResult> {
    validateLease(input.leaseMs);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.leaseMs);
    const staleQueuedBefore = new Date(now.getTime() - input.leaseMs);

    return await dbWrite.transaction(async (tx) => {
      const [activation] = await tx
        .select()
        .from(agentActivationGreetings)
        .where(
          and(
            eq(agentActivationGreetings.agent_id, input.agentId),
            eq(agentActivationGreetings.owner_user_id, input.ownerUserId),
            eq(agentActivationGreetings.activation_version, input.activationVersion),
          ),
        )
        .for("update")
        .limit(1);

      await tx
        .insert(sharedRuntimeHistory)
        .values({
          agent_id: input.agentId,
          channel_id: input.channelId,
          messages: jsonbParam([]),
          updated_at: now,
        })
        .onConflictDoNothing({
          target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        });
      const [historyRow] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, input.agentId),
            eq(sharedRuntimeHistory.channel_id, input.channelId),
          ),
        )
        .for("update")
        .limit(1);
      if (!historyRow) {
        throw new ElizaError("Shared history vanished while beginning handoff", {
          code: "SHARED_HANDOFF_HISTORY_MISSING",
          context: { agentId: input.agentId, channelId: input.channelId },
          severity: "fatal",
        });
      }

      // Recover browser requests that vanished before they could abandon their
      // queue entry or processing lease.
      await tx
        .delete(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.state, "queued"),
            lt(sharedRuntimeTurnClaims.updated_at, staleQueuedBefore),
          ),
        );
      await tx
        .delete(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            eq(sharedRuntimeTurnClaims.state, "processing"),
            lte(sharedRuntimeTurnClaims.lease_expires_at, now),
          ),
        );

      const [unfinished] = await tx
        .select({
          clientMessageId: sharedRuntimeTurnClaims.client_message_id,
          leaseExpiresAt: sharedRuntimeTurnClaims.lease_expires_at,
        })
        .from(sharedRuntimeTurnClaims)
        .where(
          and(
            eq(sharedRuntimeTurnClaims.agent_id, input.agentId),
            eq(sharedRuntimeTurnClaims.channel_id, input.channelId),
            ne(sharedRuntimeTurnClaims.state, "completed"),
          ),
        )
        .limit(1);
      if (unfinished) {
        return {
          ready: false,
          retryAfterMs: Math.max(
            100,
            (unfinished.leaseExpiresAt?.getTime() ?? now.getTime() + 1_000) - now.getTime(),
          ),
        };
      }

      const activeFence =
        historyRow.handoff_fence_token &&
        historyRow.handoff_fence_expires_at &&
        historyRow.handoff_fence_expires_at.getTime() > now.getTime();
      if (activeFence && historyRow.handoff_fence_token !== input.fenceToken) {
        return {
          ready: false,
          retryAfterMs: Math.max(
            100,
            historyRow.handoff_fence_expires_at!.getTime() - now.getTime(),
          ),
        };
      }
      if (!activeFence) {
        await tx
          .update(sharedRuntimeHistory)
          .set({
            handoff_fence_token: input.fenceToken,
            handoff_fence_expires_at: expiresAt,
            updated_at: now,
          })
          .where(
            and(
              eq(sharedRuntimeHistory.agent_id, input.agentId),
              eq(sharedRuntimeHistory.channel_id, input.channelId),
            ),
          );
      }

      return {
        ready: true,
        messages: Array.isArray(historyRow.messages) ? historyRow.messages : [],
        ...(activation ? { activation } : {}),
      };
    });
  }

  /** Release a failed handoff attempt; successful handoffs keep the fence. */
  async releaseHandoffFence(input: {
    agentId: string;
    channelId: string;
    fenceToken: string;
  }): Promise<boolean> {
    const [released] = await dbWrite
      .update(sharedRuntimeHistory)
      .set({
        handoff_fence_token: null,
        handoff_fence_expires_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(sharedRuntimeHistory.agent_id, input.agentId),
          eq(sharedRuntimeHistory.channel_id, input.channelId),
          eq(sharedRuntimeHistory.handoff_fence_token, input.fenceToken),
        ),
      )
      .returning({ channelId: sharedRuntimeHistory.channel_id });
    return Boolean(released);
  }
}

export const sharedRuntimeTurnClaimsRepository = new SharedRuntimeTurnClaimsRepository();
