/**
 * Proves migration 0132 retains its historical node selection against real
 * PostgreSQL semantics while its file, journal tag, and source stay neutral.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_TAG = "0132_legacy_static_cores_disable";
const MIGRATION_WHEN = 1779408000000;
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_PATH = join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`);
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");
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

function readJournalEntry(): JournalEntry | undefined {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries[131];
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
});
