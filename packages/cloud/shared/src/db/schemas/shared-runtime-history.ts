// Defines the shared runtime history Drizzle table shape used by cloud repositories and services.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** One persisted turn in a shared-runtime conversation. Mirrors `SharedTurnMessage`. */
export type SharedRuntimeHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  /** Epoch-ms timestamp; used to order turns merged from concurrent writers. */
  createdAt?: number;
  id?: string;
  source?: string;
  greetingKind?: "conversation" | "post_sign_in_activation";
  activationVersion?: string;
};

/**
 * Durable conversation history for Tier-0 "shared" agents (which run in-Worker
 * with no container, so they have no per-agent database of their own).
 *
 * Previously this history lived ONLY in the request cache, which is disabled on
 * the prod Worker (`CACHE_ENABLED=false`, no KV backend) — so `cache.set` was a
 * silent no-op, history never persisted, and the agent had no cross-turn memory
 * (and `GET .../messages` always returned `[]`). This table makes it durable in
 * the same Postgres the Worker already uses, independent of any cache config.
 *
 * One row per `(agent_id, channel_id)` holds the capped, ordered message list,
 * upserted each turn. Kept deliberately isolated from the encrypted/billed
 * `conversations`/`conversation_messages` tables (the chat-completions product)
 * so the lightweight shared tier stays decoupled, as designed.
 */
export const sharedRuntimeHistory = pgTable(
  "shared_runtime_history",
  {
    agent_id: text("agent_id").notNull(),
    channel_id: text("channel_id").notNull(),
    messages: jsonb("messages").$type<SharedRuntimeHistoryMessage[]>().notNull(),
    handoff_fence_token: uuid("handoff_fence_token"),
    handoff_fence_expires_at: timestamp("handoff_fence_expires_at", {
      withTimezone: true,
    }),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agent_id, table.channel_id] }),
    handoffFenceExpiry: index("shared_runtime_history_handoff_fence_expiry_idx").on(
      table.handoff_fence_expires_at,
    ),
    handoffFenceShape: check(
      "shared_runtime_history_handoff_fence_shape_check",
      sql`(
        (${table.handoff_fence_token} IS NULL AND ${table.handoff_fence_expires_at} IS NULL)
        OR
        (${table.handoff_fence_token} IS NOT NULL AND ${table.handoff_fence_expires_at} IS NOT NULL)
      )`,
    ),
  }),
);

export type SharedRuntimeHistoryRow = typeof sharedRuntimeHistory.$inferSelect;
export type NewSharedRuntimeHistoryRow = typeof sharedRuntimeHistory.$inferInsert;
