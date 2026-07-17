/**
 * Durable operation ledger for tenant-scoped voice synthesis idempotency.
 * Client keys are stored only as hashes, and every claim binds that hash to a
 * canonical request fingerprint before provider, credit, or usage work begins.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";
import { usageRecords } from "./usage-records";

export type VoiceTtsOperationStatus = "pending" | "completed" | "failed";

export const voiceTtsOperations = pgTable(
  "voice_tts_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_hash: text("request_hash").notNull(),
    status: text("status").$type<VoiceTtsOperationStatus>().notNull().default("pending"),
    reservation_transaction_id: uuid("reservation_transaction_id").references(
      () => creditTransactions.id,
      { onDelete: "set null" },
    ),
    usage_record_id: uuid("usage_record_id").references(() => usageRecords.id, {
      onDelete: "set null",
    }),
    result_key: text("result_key"),
    result_content_type: text("result_content_type"),
    result_headers: jsonb("result_headers").$type<Record<string, string>>(),
    failure_status: integer("failure_status"),
    failure_body: jsonb("failure_body").$type<Record<string, unknown>>(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenant_key_unique: uniqueIndex("voice_tts_operations_tenant_key_idx").on(
      table.organization_id,
      table.idempotency_key_hash,
    ),
    expires_idx: index("voice_tts_operations_expires_idx").on(table.expires_at),
    status_idx: index("voice_tts_operations_status_idx").on(table.status),
  }),
);

export type VoiceTtsOperation = InferSelectModel<typeof voiceTtsOperations>;
export type NewVoiceTtsOperation = InferInsertModel<typeof voiceTtsOperations>;
