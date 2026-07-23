/**
 * Durable queue and idempotency ledger for shared-runtime model turns.
 *
 * Stable client message ids become one serialized job per shared conversation.
 * The queue keeps concurrent Workers from running or billing the same turn
 * twice, while a bounded lease lets a later retry recover an abandoned job.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";

export const sharedRuntimeTurnClaims = pgTable(
  "shared_runtime_turn_claims",
  {
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    channel_id: text("channel_id").notNull(),
    client_message_id: text("client_message_id").notNull(),
    assistant_message_id: uuid("assistant_message_id").notNull(),
    owner_text: text("owner_text").notNull(),
    state: text("state").notNull().default("queued"),
    claim_token: uuid("claim_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    assistant_text: text("assistant_text"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.agent_id, table.channel_id, table.client_message_id],
    }),
    oneProcessingTurn: uniqueIndex("shared_runtime_turn_claims_one_processing_idx")
      .on(table.agent_id, table.channel_id)
      .where(sql`${table.state} = 'processing'`),
    queueOrder: index("shared_runtime_turn_claims_queue_idx").on(
      table.agent_id,
      table.channel_id,
      table.state,
      table.created_at,
      table.client_message_id,
    ),
    clientMessageLength: check(
      "shared_runtime_turn_claims_client_message_length_check",
      sql`length(${table.client_message_id}) BETWEEN 1 AND 256`,
    ),
    stateCheck: check(
      "shared_runtime_turn_claims_state_check",
      sql`${table.state} IN ('queued', 'processing', 'completed')`,
    ),
    stateShapeCheck: check(
      "shared_runtime_turn_claims_state_shape_check",
      sql`(
        (
          ${table.state} = 'queued'
          AND ${table.claim_token} IS NULL
          AND ${table.lease_expires_at} IS NULL
          AND ${table.assistant_text} IS NULL
        )
        OR
        (
          ${table.state} = 'processing'
          AND ${table.claim_token} IS NOT NULL
          AND ${table.lease_expires_at} IS NOT NULL
          AND ${table.assistant_text} IS NULL
        )
        OR
        (
          ${table.state} = 'completed'
          AND ${table.claim_token} IS NULL
          AND ${table.lease_expires_at} IS NULL
          AND ${table.assistant_text} IS NOT NULL
          AND length(trim(${table.assistant_text})) > 0
        )
      )`,
    ),
  }),
);

export type SharedRuntimeTurnClaim = typeof sharedRuntimeTurnClaims.$inferSelect;
export type NewSharedRuntimeTurnClaim = typeof sharedRuntimeTurnClaims.$inferInsert;
