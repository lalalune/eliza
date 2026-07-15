/**
 * Selects pending Drizzle migrations from the ledger's timestamp cursor.
 * The diagnostic migration CLI and its upgrade-safety tests share this seam so
 * a rewritten migration keeps its original applied/not-applied decision.
 */

import { ElizaError } from "../../../core/src/errors.ts";

export interface AppliedMigrationCursor {
  created_at: string | number | bigint | null;
}

export function migrationCursorValue(
  migration: AppliedMigrationCursor | undefined,
): number | null {
  if (!migration) return null;

  const rawValue = migration.created_at;
  if (
    rawValue === null ||
    (typeof rawValue === "string" && rawValue.trim().length === 0)
  ) {
    throw new ElizaError(
      "Migration ledger contains an empty created_at cursor",
      {
        code: "DB_MIGRATION_CURSOR_INVALID",
        context: { createdAt: rawValue === null ? null : String(rawValue) },
        severity: "fatal",
      },
    );
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ElizaError(
      `Migration ledger contains an invalid created_at cursor: ${rawValue}`,
      {
        code: "DB_MIGRATION_CURSOR_INVALID",
        context: { createdAt: String(rawValue) },
        severity: "fatal",
      },
    );
  }
  return value;
}

export function selectPendingMigrations<T extends { entry: { when: number } }>(
  migrations: readonly T[],
  lastApplied: AppliedMigrationCursor | undefined,
): T[] {
  const lastAppliedCreatedAt = migrationCursorValue(lastApplied);
  return migrations.filter(
    (migration) =>
      lastAppliedCreatedAt === null ||
      migration.entry.when > lastAppliedCreatedAt,
  );
}
