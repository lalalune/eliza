/**
 * Proves migration 0132 remains a runnable, inert journal slot. The real
 * Drizzle ledger checks cover both a fresh database and an already-applied
 * database without requiring historical infrastructure identifiers.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const MIGRATION_TAG = "0132_reserved_migration_slot";
const MIGRATION_WHEN = 1779408000000;
const APPLIED_MIGRATION_HASH = "ebf27fedc8ecfdcf6318e4d194412808e5405473c9cc11cc62916060379d28e1";
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_PATH = join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`);
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournalEntry(): JournalEntry | undefined {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries[131];
}

function writeSingleMigrationFixture(root: string, migrationSql: string): string {
  const migrationsDir = join(root, "migrations");
  mkdirSync(join(migrationsDir, "meta"), { recursive: true });
  writeFileSync(join(migrationsDir, `${MIGRATION_TAG}.sql`), migrationSql);
  writeFileSync(
    join(migrationsDir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 131,
          version: "7",
          when: MIGRATION_WHEN,
          tag: MIGRATION_TAG,
          breakpoints: true,
        },
      ],
    }),
  );
  return migrationsDir;
}

async function seedAppliedMigration(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES ('${APPLIED_MIGRATION_HASH}', ${MIGRATION_WHEN});
  `);
}

describe("neutralized static core migration slot", () => {
  test("keeps the deployed journal cursor and matching filename", () => {
    expect(readJournalEntry()).toMatchObject({
      idx: 131,
      when: MIGRATION_WHEN,
      tag: MIGRATION_TAG,
    });
    expect(readdirSync(MIGRATIONS_DIR)).toContain(`${MIGRATION_TAG}.sql`);
  });

  test("runs safely on a fresh database and records the current file hash", async () => {
    const database = await PGlite.create();
    const fixtureRoot = mkdtempSync(join(tmpdir(), "static-core-migration-"));
    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
    const migrationFixture = writeSingleMigrationFixture(fixtureRoot, migrationSql);

    try {
      await migrate(drizzle(database), { migrationsFolder: migrationFixture });
      const ledger = await database.query<{ hash: string; created_at: number }>(
        "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
      );
      expect(ledger.rows).toEqual([
        {
          hash: createHash("sha256").update(migrationSql).digest("hex"),
          created_at: MIGRATION_WHEN,
        },
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      await database.close();
    }
  });

  test("does not replay any SQL after the journal cursor is present", async () => {
    const database = await PGlite.create();
    const fixtureRoot = mkdtempSync(join(tmpdir(), "static-core-migration-"));
    const migrationFixture = writeSingleMigrationFixture(
      fixtureRoot,
      "CREATE TABLE migration_replay_probe (id integer PRIMARY KEY);",
    );

    try {
      await seedAppliedMigration(database);
      await migrate(drizzle(database), { migrationsFolder: migrationFixture });

      const probe = await database.query<{ name: string | null }>(
        "SELECT to_regclass('public.migration_replay_probe')::text AS name",
      );
      expect(probe.rows).toEqual([{ name: null }]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      await database.close();
    }
  });
});
