// Persists shared runtime history records for cloud services through the shared DB boundary.
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";

import { dbRead, dbWrite } from "../client";
import {
  type SharedRuntimeHistoryMessage,
  sharedRuntimeHistory,
} from "../schemas/shared-runtime-history";
import { jsonbParam } from "../utils/jsonb";

/**
 * Durable persistence for shared-runtime (Tier-0) conversation history. Replaces
 * the request-cache store (a no-op when `CACHE_ENABLED=false` on the Worker) so
 * a shared agent keeps cross-turn memory and `GET .../messages` returns history.
 * One canonical row per `(agentId, channelId)`. New turns append under a row
 * lock so concurrent model turns and deterministic activation messages cannot
 * overwrite one another with stale full-history snapshots.
 */
export class SharedRuntimeHistoryRepository {
  async get(agentId: string, channelId: string): Promise<SharedRuntimeHistoryMessage[]> {
    const row = await dbRead.query.sharedRuntimeHistory.findFirst({
      where: and(
        eq(sharedRuntimeHistory.agent_id, agentId),
        eq(sharedRuntimeHistory.channel_id, channelId),
      ),
    });
    return Array.isArray(row?.messages) ? row.messages : [];
  }

  /**
   * Delete ALL shared-runtime history rows for an agent (every channel),
   * called when the agent itself is deleted. Without this, a shared agent's
   * cross-turn history is orphaned: the canonical `agent_sandboxes` row is
   * gone but its `(agent_id, channel_id)` rows linger forever (no FK cascade —
   * this table is deliberately decoupled from the sandbox/conversation tables).
   * Returns the number of rows removed so the caller can log the cleanup.
   */
  async deleteByAgent(agentId: string): Promise<number> {
    const deleted = await dbWrite
      .delete(sharedRuntimeHistory)
      .where(eq(sharedRuntimeHistory.agent_id, agentId))
      .returning({ channelId: sharedRuntimeHistory.channel_id });
    return deleted.length;
  }

  /**
   * Seed one ordinary greeting only while a room is empty.
   *
   * Inserting an empty row first turns the composite primary key into the
   * cross-process lock for a never-before-seen room. The subsequent row lock
   * serializes the empty-check and write, so concurrent browser hydrations
   * cannot both append a greeting.
   */
  async ensureConversationGreeting(
    agentId: string,
    channelId: string,
    candidate: SharedRuntimeHistoryMessage,
  ): Promise<{
    greeting: SharedRuntimeHistoryMessage | null;
    persisted: boolean;
  }> {
    return await dbWrite.transaction(async (tx) => {
      await tx
        .insert(sharedRuntimeHistory)
        .values({
          agent_id: agentId,
          channel_id: channelId,
          messages: jsonbParam([]),
          updated_at: new Date(),
        })
        .onConflictDoNothing({
          target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        });

      const [row] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        )
        .for("update")
        .limit(1);
      const messages = Array.isArray(row?.messages) ? row.messages : [];
      const existing = messages.find(
        (message) =>
          message.role === "assistant" &&
          message.source === "agent_greeting" &&
          message.greetingKind === "conversation" &&
          typeof message.id === "string",
      );
      if (existing) {
        return { greeting: existing, persisted: false };
      }
      if (messages.length > 0) {
        return { greeting: null, persisted: false };
      }

      await tx
        .update(sharedRuntimeHistory)
        .set({
          messages: jsonbParam([candidate]),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        );
      return { greeting: candidate, persisted: true };
    });
  }

  /**
   * Append one deterministic message if its id is not already in the room.
   *
   * Activation delivery uses this once to project the global ledger into
   * model-visible history. A separate projected marker prevents later room
   * deletion from turning a durable retry into a visible replay.
   */
  async ensureMessage(
    agentId: string,
    channelId: string,
    candidate: SharedRuntimeHistoryMessage & { id: string },
  ): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      await tx
        .insert(sharedRuntimeHistory)
        .values({
          agent_id: agentId,
          channel_id: channelId,
          messages: jsonbParam([]),
          updated_at: new Date(),
        })
        .onConflictDoNothing({
          target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        });

      const [row] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        )
        .for("update")
        .limit(1);
      const messages = Array.isArray(row?.messages) ? row.messages : [];
      const existing = messages.find((message) => message.id === candidate.id);
      if (existing) {
        if (
          existing.role !== candidate.role ||
          existing.content !== candidate.content ||
          existing.createdAt !== candidate.createdAt ||
          existing.source !== candidate.source ||
          existing.greetingKind !== candidate.greetingKind ||
          existing.activationVersion !== candidate.activationVersion
        ) {
          throw new ElizaError(
            "Shared runtime history contains a conflicting deterministic message",
            {
              code: "SHARED_HISTORY_MESSAGE_CONFLICT",
              context: { agentId, channelId, messageId: candidate.id },
              severity: "fatal",
            },
          );
        }
        return false;
      }

      await tx
        .update(sharedRuntimeHistory)
        .set({
          messages: jsonbParam([...messages, candidate]),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        );
      return true;
    });
  }

  /**
   * Atomically append completed turn messages and retain the newest bounded
   * window. Callers pass only the newly completed messages, never a previously
   * read snapshot: the row lock makes concurrent turns converge without a
   * last-writer-wins history loss.
   */
  async append(
    agentId: string,
    channelId: string,
    messages: SharedRuntimeHistoryMessage[],
    maxMessages: number,
  ): Promise<void> {
    if (messages.length === 0) return;
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new ElizaError("Shared runtime history requires a positive integer window", {
        code: "INVALID_SHARED_HISTORY_WINDOW",
        context: { agentId, channelId, maxMessages },
        severity: "ephemeral",
      });
    }

    await dbWrite.transaction(async (tx) => {
      await tx
        .insert(sharedRuntimeHistory)
        .values({
          agent_id: agentId,
          channel_id: channelId,
          messages: jsonbParam([]),
          updated_at: new Date(),
        })
        .onConflictDoNothing({
          target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        });

      const [row] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) {
        throw new ElizaError("Shared runtime history row vanished while appending", {
          code: "SHARED_HISTORY_ROW_MISSING",
          context: { agentId, channelId },
          severity: "fatal",
        });
      }

      const current = Array.isArray(row.messages) ? row.messages : [];
      const appended: SharedRuntimeHistoryMessage[] = [];
      for (const candidate of messages) {
        const existing =
          typeof candidate.id === "string"
            ? current.find((message) => message.id === candidate.id)
            : undefined;
        if (!existing) {
          appended.push(candidate);
          continue;
        }
        if (existing.role !== candidate.role || existing.content !== candidate.content) {
          throw new ElizaError("Shared runtime turn reused a message id with different content", {
            code: "SHARED_HISTORY_TURN_CONFLICT",
            context: {
              agentId,
              channelId,
              messageId: candidate.id,
            },
            severity: "fatal",
          });
        }
      }
      if (appended.length === 0) return;

      const combined = [...current, ...appended];
      const capped =
        combined.length > maxMessages ? combined.slice(combined.length - maxMessages) : combined;
      await tx
        .update(sharedRuntimeHistory)
        .set({
          messages: jsonbParam(capped),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        );
    });
  }

  /**
   * Replace a room snapshot for controlled seeding/import operations.
   * Interactive turns use {@link append}; replacing a snapshot after a read
   * would permit concurrent writers to erase messages.
   */
  async upsert(
    agentId: string,
    channelId: string,
    messages: SharedRuntimeHistoryMessage[],
  ): Promise<void> {
    const now = new Date();
    await dbWrite
      .insert(sharedRuntimeHistory)
      .values({
        agent_id: agentId,
        channel_id: channelId,
        // Bind JSONB explicitly as a JSON string (Neon serverless driver can
        // mis-bind raw JS arrays/objects as query params). The insert value
        // type accepts a raw `SQL` expression per column, so no cast is needed.
        messages: jsonbParam(messages),
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        set: {
          messages: jsonbParam(messages),
          updated_at: now,
        },
      });
  }
}

export const sharedRuntimeHistoryRepository = new SharedRuntimeHistoryRepository();
