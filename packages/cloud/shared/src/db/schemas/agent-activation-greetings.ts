/**
 * Durable exactly-once activation messages for managed agents.
 *
 * The activation ledger is deliberately independent of conversation history:
 * deleting or replacing a room must not make a signed-in owner eligible for the
 * same activation version again. The composite primary key is the delivery
 * contract; the stored message fields preserve the winning identity while
 * `projected_at` distinguishes interrupted first delivery from a later room
 * deletion that must not replay the activation.
 */

import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";
import { users } from "./users";

export const agentActivationGreetings = pgTable(
  "agent_activation_greetings",
  {
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activation_version: text("activation_version").notNull(),
    conversation_id: text("conversation_id").notNull(),
    message_id: uuid("message_id").notNull(),
    source: text("source").notNull(),
    greeting_kind: text("greeting_kind").notNull(),
    text: text("text").notNull(),
    agent_name: text("agent_name").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    projected_at: timestamp("projected_at", { withTimezone: true }),
    goal_status: text("goal_status").notNull().default("pending"),
    response_message_id: text("response_message_id"),
    response_text: text("response_text"),
    response_created_at: timestamp("response_created_at", {
      withTimezone: true,
    }),
    goal_text: text("goal_text"),
    goal_confidence: doublePrecision("goal_confidence"),
    goal_model: text("goal_model"),
    goal_recorded_at: timestamp("goal_recorded_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.agent_id, table.owner_user_id, table.activation_version],
    }),
    messageIdUnique: uniqueIndex("agent_activation_greetings_message_id_unique").on(
      table.message_id,
    ),
    goalStatusCheck: check(
      "agent_activation_greetings_goal_status_check",
      sql`${table.goal_status} IN ('pending', 'accepted')`,
    ),
    responseShapeCheck: check(
      "agent_activation_greetings_response_shape_check",
      sql`(
        (${table.response_message_id} IS NULL AND ${table.response_text} IS NULL AND ${table.response_created_at} IS NULL)
        OR
        (${table.response_message_id} IS NOT NULL AND ${table.response_text} IS NOT NULL AND ${table.response_created_at} IS NOT NULL)
      )`,
    ),
    goalShapeCheck: check(
      "agent_activation_greetings_goal_shape_check",
      sql`(
        (${table.goal_status} = 'pending' AND ${table.goal_text} IS NULL AND ${table.goal_confidence} IS NULL AND ${table.goal_model} IS NULL AND ${table.goal_recorded_at} IS NULL)
        OR
        (
          ${table.goal_status} = 'accepted'
          AND ${table.response_message_id} IS NOT NULL
          AND ${table.goal_text} IS NOT NULL
          AND length(trim(${table.goal_text})) > 0
          AND ${table.goal_confidence} BETWEEN 0 AND 1
          AND ${table.goal_model} IS NOT NULL
          AND ${table.goal_recorded_at} IS NOT NULL
        )
      )`,
    ),
  }),
);

export type AgentActivationGreeting = typeof agentActivationGreetings.$inferSelect;
export type NewAgentActivationGreeting = typeof agentActivationGreetings.$inferInsert;
