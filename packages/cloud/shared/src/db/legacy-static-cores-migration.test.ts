/**
 * Proves migration 0132 preserves its deployed cursor while failing closed for
 * stale pre-autoscaler capacity. The suite drives real PostgreSQL semantics and
 * Drizzle ledger behavior without requiring historical node identifiers.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const MIGRATION_TAG = "0132_pre_autoscaler_node_guard";
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

async function createDockerNodesTable(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE TABLE docker_nodes (
      node_id text PRIMARY KEY,
      capacity integer NOT NULL,
      enabled boolean NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL
    );
  `);
}

describe("pre-autoscaler node migration guard", () => {
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

  test("fails closed without mutating suspicious pre-autoscaler capacity", async () => {
    const database = await PGlite.create();
    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

    try {
      await createDockerNodesTable(database);
      await database.exec(`
        INSERT INTO docker_nodes (node_id, capacity, enabled, status, created_at)
        VALUES ('pre-autoscaler-node', 100, true, 'healthy', '2026-03-15T00:00:00Z');
      `);

      await expect(database.exec(migrationSql)).rejects.toThrow(
        /pre-autoscaler nodes require explicit operator review/,
      );
      const nodes = await database.query<{ capacity: number; enabled: boolean }>(
        "SELECT capacity, enabled FROM docker_nodes",
      );
      expect(nodes.rows).toEqual([{ capacity: 100, enabled: true }]);
    } finally {
      await database.close();
    }
  });

  test("allows nodes outside every guarded condition without mutation", async () => {
    const database = await PGlite.create();
    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

    try {
      await createDockerNodesTable(database);
      await database.exec(`
        INSERT INTO docker_nodes (node_id, capacity, enabled, status, created_at)
        VALUES
          ('bounded', 8, true, 'offline', '2026-03-15T00:00:00Z'),
          ('cutoff', 100, true, 'offline', '2026-05-22T00:00:00Z'),
          ('disabled', 100, false, 'offline', '2026-03-15T00:00:00Z');
      `);

      await database.exec(migrationSql);
      const nodes = await database.query<{
        node_id: string;
        capacity: number;
        enabled: boolean;
        status: string;
      }>("SELECT node_id, capacity, enabled, status FROM docker_nodes ORDER BY node_id");
      expect(nodes.rows).toEqual([
        { node_id: "bounded", capacity: 8, enabled: true, status: "offline" },
        { node_id: "cutoff", capacity: 100, enabled: true, status: "offline" },
        {
          node_id: "disabled",
          capacity: 100,
          enabled: false,
          status: "offline",
        },
      ]);
    } finally {
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
