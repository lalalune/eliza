/**
 * Applies the real handoff-fence migration to a PGlite history table.
 *
 * The proof covers journal registration, pair-shape enforcement, indexing, and
 * rollback so turn admission and snapshot fencing share the deployed schema.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const upUrl = new URL("./migrations/0179_shared_runtime_handoff_fence.sql", import.meta.url);
const downUrl = new URL("./migrations/0179_shared_runtime_handoff_fence.down.sql", import.meta.url);

let dbWrite: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let databaseReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
    await dbWrite.execute(`
      CREATE TABLE shared_runtime_history (
        agent_id text NOT NULL,
        channel_id text NOT NULL,
        messages jsonb NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );
    `);
  } catch (error) {
    databaseReady = false;
    console.error("[shared-runtime-handoff-fence-migration] setup failed", error);
  }
}, 60_000);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("0179 shared runtime handoff fence migration", () => {
  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((entry) => entry.tag === "0179_shared_runtime_handoff_fence")).toBe(
      true,
    );
  });

  test("adds an all-or-none fence and rolls it back", async () => {
    expect(databaseReady).toBe(true);
    const up = readFileSync(fileURLToPath(upUrl), "utf8")
      .replaceAll("--> statement-breakpoint", "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of up) await dbWrite.execute(statement);

    await dbWrite.execute(`
      INSERT INTO shared_runtime_history (
        agent_id, channel_id, messages, handoff_fence_token,
        handoff_fence_expires_at
      ) VALUES (
        'agent-a', 'room-a', '[]'::jsonb,
        '11111111-1111-4111-8111-111111111111',
        now() + interval '2 minutes'
      );
    `);
    await expect(
      (async () =>
        await dbWrite.execute(`
          INSERT INTO shared_runtime_history (
            agent_id, channel_id, messages, handoff_fence_token
          ) VALUES (
            'agent-b', 'room-b', '[]'::jsonb,
            '22222222-2222-4222-8222-222222222222'
          );
        `))(),
    ).rejects.toThrow();

    const index = await dbWrite.execute(`
      SELECT indexname
      FROM pg_indexes
      WHERE indexname = 'shared_runtime_history_handoff_fence_expiry_idx';
    `);
    expect(index.rows).toHaveLength(1);

    const down = readFileSync(fileURLToPath(downUrl), "utf8")
      .replaceAll("--> statement-breakpoint", "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of down) await dbWrite.execute(statement);
    const columns = await dbWrite.execute(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'shared_runtime_history'
        AND column_name LIKE 'handoff_fence_%';
    `);
    expect(columns.rows).toEqual([]);
  });
});
