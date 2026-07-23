/**
 * Atomic persistence for exactly-once post-sign-in activation messages.
 *
 * Concurrent requests may target different rooms, but they contend on one
 * owner-scoped activation key. The first insert wins; every loser reads that
 * committed row from the primary connection so replicas and process-local
 * locks cannot produce divergent message identities or timestamps.
 */

import { ElizaError } from "@elizaos/core";
import {
  FTU_GOAL_CONFIDENCE_THRESHOLD,
  type FtuGoalDiscoveryOutput,
} from "@elizaos/shared/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { dbWrite } from "../client";
import {
  type AgentActivationGreeting,
  agentActivationGreetings,
  type NewAgentActivationGreeting,
} from "../schemas/agent-activation-greetings";
import {
  type SharedRuntimeHistoryMessage,
  sharedRuntimeHistory,
} from "../schemas/shared-runtime-history";
import { jsonbParam } from "../utils/jsonb";

export interface EnsuredAgentActivationGreeting {
  greeting: AgentActivationGreeting;
  persisted: boolean;
}

export interface ActivationResponseTurnInput {
  agentId: string;
  ownerUserId: string;
  activationVersion: string;
  channelId: string;
  completedMessages: [
    SharedRuntimeHistoryMessage & { id: string; role: "user" },
    SharedRuntimeHistoryMessage & { id: string; role: "assistant" },
  ];
  maxMessages: number;
  extraction: FtuGoalDiscoveryOutput;
  extractionModel: string;
}

export interface ActivationResponseTurnResult {
  greeting: AgentActivationGreeting;
  persisted: boolean;
  assistantReply: string;
}

export class AgentActivationGreetingsRepository {
  async ensure(candidate: NewAgentActivationGreeting): Promise<EnsuredAgentActivationGreeting> {
    const [inserted] = await dbWrite
      .insert(agentActivationGreetings)
      .values(candidate)
      .onConflictDoNothing({
        target: [
          agentActivationGreetings.agent_id,
          agentActivationGreetings.owner_user_id,
          agentActivationGreetings.activation_version,
        ],
      })
      .returning();

    if (inserted) {
      return { greeting: inserted, persisted: true };
    }

    // PostgreSQL waits for the conflicting insert to commit before completing
    // ON CONFLICT DO NOTHING. Reading from the primary here therefore returns
    // the winner even when the two requests came from different Worker isolates.
    const [existing] = await dbWrite
      .select()
      .from(agentActivationGreetings)
      .where(
        and(
          eq(agentActivationGreetings.agent_id, candidate.agent_id),
          eq(agentActivationGreetings.owner_user_id, candidate.owner_user_id),
          eq(agentActivationGreetings.activation_version, candidate.activation_version),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new ElizaError("Activation greeting conflict completed without a readable ledger row", {
        code: "ACTIVATION_GREETING_CONFLICT_READ_FAILED",
        context: {
          agentId: candidate.agent_id,
          ownerUserId: candidate.owner_user_id,
          activationVersion: candidate.activation_version,
        },
        severity: "fatal",
      });
    }

    return { greeting: existing, persisted: false };
  }

  async find(
    agentId: string,
    ownerUserId: string,
    activationVersion: string,
  ): Promise<AgentActivationGreeting | undefined> {
    const [row] = await dbWrite
      .select()
      .from(agentActivationGreetings)
      .where(
        and(
          eq(agentActivationGreetings.agent_id, agentId),
          eq(agentActivationGreetings.owner_user_id, ownerUserId),
          eq(agentActivationGreetings.activation_version, activationVersion),
        ),
      )
      .limit(1);
    return row;
  }

  async markProjected(
    agentId: string,
    ownerUserId: string,
    activationVersion: string,
  ): Promise<AgentActivationGreeting> {
    const [updated] = await dbWrite
      .update(agentActivationGreetings)
      .set({ projected_at: new Date() })
      .where(
        and(
          eq(agentActivationGreetings.agent_id, agentId),
          eq(agentActivationGreetings.owner_user_id, ownerUserId),
          eq(agentActivationGreetings.activation_version, activationVersion),
          isNull(agentActivationGreetings.projected_at),
        ),
      )
      .returning();
    if (updated) return updated;

    const existing = await this.find(agentId, ownerUserId, activationVersion);
    if (!existing) {
      throw new ElizaError(
        "Activation greeting projection completed without a readable ledger row",
        {
          code: "ACTIVATION_GREETING_PROJECTION_READ_FAILED",
          context: { agentId, ownerUserId, activationVersion },
          severity: "fatal",
        },
      );
    }
    return existing;
  }

  /**
   * Commit the owner's candidate response and completed model turn together.
   *
   * The activation row is locked before the history row. A retry carrying the
   * same stable message ids reads the winning assistant reply instead of
   * appending another turn or overwriting the accepted goal.
   */
  async appendResponseTurn(
    input: ActivationResponseTurnInput,
  ): Promise<ActivationResponseTurnResult> {
    if (!Number.isInteger(input.maxMessages) || input.maxMessages < 1) {
      throw new ElizaError("Activation response requires a positive history window", {
        code: "INVALID_ACTIVATION_HISTORY_WINDOW",
        context: {
          agentId: input.agentId,
          maxMessages: input.maxMessages,
        },
        severity: "ephemeral",
      });
    }

    return await dbWrite.transaction(async (tx) => {
      const [greeting] = await tx
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
      if (!greeting || greeting.projected_at === null) {
        throw new ElizaError("Activation response arrived before a projected activation greeting", {
          code: "ACTIVATION_RESPONSE_WITHOUT_GREETING",
          context: {
            agentId: input.agentId,
            ownerUserId: input.ownerUserId,
            activationVersion: input.activationVersion,
          },
          severity: "ephemeral",
        });
      }

      await tx
        .insert(sharedRuntimeHistory)
        .values({
          agent_id: input.agentId,
          channel_id: input.channelId,
          messages: jsonbParam([]),
          updated_at: new Date(),
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
        throw new ElizaError("Shared history row vanished during activation response commit", {
          code: "ACTIVATION_RESPONSE_HISTORY_MISSING",
          context: {
            agentId: input.agentId,
            channelId: input.channelId,
          },
          severity: "fatal",
        });
      }

      const current = Array.isArray(historyRow.messages) ? historyRow.messages : [];
      const [ownerMessage, assistantMessage] = input.completedMessages;
      const existingOwnerIndex = current.findIndex((message) => message.id === ownerMessage.id);
      if (existingOwnerIndex >= 0) {
        const existingAssistant = current.find((message) => message.id === assistantMessage.id);
        if (
          !existingAssistant ||
          existingAssistant.role !== "assistant" ||
          !existingAssistant.content.trim()
        ) {
          throw new ElizaError(
            "Activation response history contains an incomplete idempotent turn",
            {
              code: "ACTIVATION_RESPONSE_TURN_INCOMPLETE",
              context: {
                agentId: input.agentId,
                ownerMessageId: ownerMessage.id,
                assistantMessageId: assistantMessage.id,
              },
              severity: "fatal",
            },
          );
        }
        return {
          greeting,
          persisted: false,
          assistantReply: existingAssistant.content,
        };
      }

      const combined = [...current, ownerMessage, assistantMessage];
      const capped =
        combined.length > input.maxMessages
          ? combined.slice(combined.length - input.maxMessages)
          : combined;
      await tx
        .update(sharedRuntimeHistory)
        .set({
          messages: jsonbParam(capped),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, input.agentId),
            eq(sharedRuntimeHistory.channel_id, input.channelId),
          ),
        );

      let nextGreeting = greeting;
      if (greeting.goal_status !== "accepted") {
        const accepted =
          input.extraction.goalFound &&
          input.extraction.goal.length > 0 &&
          input.extraction.confidence >= FTU_GOAL_CONFIDENCE_THRESHOLD;
        const responseCreatedAt = new Date(ownerMessage.createdAt ?? Date.now());
        const recordedAt = new Date();
        const [updated] = await tx
          .update(agentActivationGreetings)
          .set({
            response_message_id: ownerMessage.id,
            response_text: ownerMessage.content,
            response_created_at: responseCreatedAt,
            goal_status: accepted ? "accepted" : "pending",
            goal_text: accepted ? input.extraction.goal : null,
            goal_confidence: accepted ? input.extraction.confidence : null,
            goal_model: accepted ? input.extractionModel : null,
            goal_recorded_at: accepted ? recordedAt : null,
          })
          .where(
            and(
              eq(agentActivationGreetings.agent_id, input.agentId),
              eq(agentActivationGreetings.owner_user_id, input.ownerUserId),
              eq(agentActivationGreetings.activation_version, input.activationVersion),
            ),
          )
          .returning();
        if (!updated) {
          throw new ElizaError("Activation response update completed without a ledger row", {
            code: "ACTIVATION_RESPONSE_UPDATE_MISSING",
            context: {
              agentId: input.agentId,
              ownerUserId: input.ownerUserId,
            },
            severity: "fatal",
          });
        }
        nextGreeting = updated;
      }

      return {
        greeting: nextGreeting,
        persisted: true,
        assistantReply: assistantMessage.content,
      };
    });
  }
}

export const agentActivationGreetingsRepository = new AgentActivationGreetingsRepository();
