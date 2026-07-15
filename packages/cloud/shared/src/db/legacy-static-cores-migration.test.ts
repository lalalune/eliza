/**
 * Proves migration 0132 retains its historical node selection against real
 * PostgreSQL semantics while its file, journal tag, and source stay neutral.
 * It also exercises Drizzle's real ledger cursor so already-migrated databases
 * do not replay the rewritten file during an upgrade.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { selectPendingMigrations } from "../../../../scripts/cloud/admin/migration-selection.ts";

const MIGRATION_TAG = "0132_legacy_static_cores_disable";
const MIGRATION_WHEN = 1779408000000;
const HISTORICAL_MIGRATION_HASH =
  "ebf27fedc8ecfdcf6318e4d194412808e5405473c9cc11cc62916060379d28e1";
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_PATH = join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`);
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

function writeSingleMigrationFixture(root: string): string {
  const migrationsDir = join(root, "packages", "cloud", "shared", "src", "db", "migrations");
  mkdirSync(join(migrationsDir, "meta"), { recursive: true });
  writeFileSync(join(migrationsDir, `${MIGRATION_TAG}.sql`), readFileSync(MIGRATION_PATH, "utf8"));
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
const RETIRED_LABEL = String.fromCharCode(109, 105, 108, 97, 100, 121);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface NodeState {
  node_id: string;
  capacity: number;
  enabled: boolean;
}

function readJournalEntries(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

function readJournalEntry(): JournalEntry | undefined {
  return readJournalEntries()[131];
}

describe("legacy static core retirement migration", () => {
  test("keeps the original journal cursor and a matching neutral filename", () => {
    expect(readJournalEntry()).toMatchObject({
      idx: 131,
      when: MIGRATION_WHEN,
      tag: MIGRATION_TAG,
    });
    expect(readdirSync(MIGRATIONS_DIR)).toContain(`${MIGRATION_TAG}.sql`);
  });

  test("keeps the retired label out of migration paths and source", () => {
    const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    expect(migrationFiles.filter((name) => name.toLowerCase().includes(RETIRED_LABEL))).toEqual([]);

    for (const path of [
      ...migrationFiles.map((name) => join(MIGRATIONS_DIR, name)),
      JOURNAL_PATH,
    ]) {
      expect(readFileSync(path, "utf8").toLowerCase()).not.toContain(RETIRED_LABEL);
    }
  });

  test("disables only the retired static-node family", async () => {
    const database = await PGlite.create();
    const retiredNode = `${RETIRED_LABEL}-core-retired-1`;
    const retiredPrefixOnly = `${RETIRED_LABEL}-core-`;
    const currentNode = "eliza-core-current-1";
    const uppercaseNode = `${RETIRED_LABEL.toUpperCase()}-core-retired-2`;
    const embeddedNode = `prefix-${RETIRED_LABEL}-core-retired-3`;
    const missingSeparator = `${RETIRED_LABEL}-core`;

    try {
      await database.exec(`
        CREATE TABLE docker_nodes (
          node_id text PRIMARY KEY,
          capacity integer NOT NULL,
          enabled boolean NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      for (const nodeId of [
        retiredNode,
        retiredPrefixOnly,
        currentNode,
        uppercaseNode,
        embeddedNode,
        missingSeparator,
      ]) {
        await database.query(
          "INSERT INTO docker_nodes (node_id, capacity, enabled) VALUES ($1, 100, true)",
          [nodeId],
        );
      }

      await database.exec(readFileSync(MIGRATION_PATH, "utf8"));
      const result = await database.query<NodeState>(
        "SELECT node_id, capacity, enabled FROM docker_nodes ORDER BY node_id",
      );
      const states = new Map(result.rows.map((row) => [row.node_id, row]));

      expect(states.get(retiredNode)).toMatchObject({
        capacity: 8,
        enabled: false,
      });
      expect(states.get(retiredPrefixOnly)).toMatchObject({
        capacity: 8,
        enabled: false,
      });
      for (const nodeId of [currentNode, uppercaseNode, embeddedNode, missingSeparator]) {
        expect(states.get(nodeId)).toMatchObject({
          capacity: 100,
          enabled: true,
        });
      }
    } finally {
      await database.close();
    }
  });

  test("does not replay on a database carrying the historical ledger cursor", async () => {
    const database = await PGlite.create();
    const fixtureRoot = mkdtempSync(join(tmpdir(), "static-core-migration-"));
    const migrationFixture = writeSingleMigrationFixture(fixtureRoot);
    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

    try {
      await database.exec(`
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (
          id serial PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        );
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES ('${HISTORICAL_MIGRATION_HASH}', ${MIGRATION_WHEN});
      `);

      expect(createHash("sha256").update(migrationSql).digest("hex")).not.toBe(
        HISTORICAL_MIGRATION_HASH,
      );

      // docker_nodes intentionally does not exist: a replay would fail here.
      await migrate(drizzle(database), { migrationsFolder: migrationFixture });

      const ledger = await database.query<{ hash: string; created_at: number }>(
        "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
      );
      expect(ledger.rows).toEqual([
        {
          hash: HISTORICAL_MIGRATION_HASH,
          created_at: MIGRATION_WHEN,
        },
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      await database.close();
    }
  });

  test("the default migration runner skips the rewritten migration at the historical cursor", () => {
    const journalEntries = readJournalEntries();
    const currentEntry = journalEntries.find((entry) => entry.tag === MIGRATION_TAG);
    const nextEntry = journalEntries
      .filter((entry) => entry.when > MIGRATION_WHEN)
      .sort((left, right) => left.when - right.when)[0];
    if (!currentEntry || !nextEntry) {
      throw new Error("Migration cursor fixture requires 0132 and a later entry");
    }

    const historicalCursor = {
      id: 132,
      hash: HISTORICAL_MIGRATION_HASH,
      created_at: MIGRATION_WHEN,
    };
    const pending = selectPendingMigrations(
      [
        {
          entry: currentEntry,
          hash: createHash("sha256").update(readFileSync(MIGRATION_PATH, "utf8")).digest("hex"),
          statements: [],
        },
        { entry: nextEntry, hash: "next", statements: [] },
      ],
      historicalCursor,
    );

    expect(pending.map((migration) => migration.entry.tag)).toEqual([nextEntry.tag]);
  });

  test("the default migration runner distinguishes an empty ledger from a corrupt cursor", () => {
    const migrations = [{ entry: { when: MIGRATION_WHEN } }];

    expect(selectPendingMigrations(migrations, undefined)).toEqual(migrations);
    expect(selectPendingMigrations(migrations, { created_at: 0 })).toEqual(migrations);
    for (const created_at of [null, "", "not-a-timestamp", -1]) {
      try {
        selectPendingMigrations(migrations, { created_at });
        throw new Error("Expected a corrupt migration cursor to fail closed");
      } catch (error) {
        expect(error).toMatchObject({
          code: "DB_MIGRATION_CURSOR_INVALID",
          severity: "fatal",
        });
      }
    }
  });
});
