/**
 * Applies and rolls back the real shared-turn claim migration on PGlite.
 *
 * The proof covers journal registration, replay safety, state constraints,
 * one-processing-turn enforcement, the sandbox cascade, and rollback.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const upUrl = new URL("./migrations/0178_shared_runtime_turn_claims.sql", import.meta.url);
const downUrl = new URL("./migrations/0178_shared_runtime_turn_claims.down.sql", import.meta.url);

let dbWrite: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let databaseReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
    await dbWrite.execute("CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY);");
    await dbWrite.execute(`INSERT INTO agent_sandboxes (id) VALUES ('${AGENT_ID}');`);
  } catch (error) {
    databaseReady = false;
    console.error("[shared-runtime-turn-claims-migration] PGlite setup failed", error);
  }
}, 60_000);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("0178 shared runtime turn claims migration", () => {
  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((entry) => entry.tag === "0178_shared_runtime_turn_claims")).toBe(
      true,
    );
  });

  test("applies, enforces queue invariants, replays, cascades, and rolls back", async () => {
    expect(databaseReady).toBe(true);
    const up = readFileSync(fileURLToPath(upUrl), "utf8");
    const statements = up
      .replaceAll("--> statement-breakpoint", "")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) await dbWrite.execute(statement);
    for (const statement of statements) await dbWrite.execute(statement);

    await dbWrite.execute(`
      INSERT INTO shared_runtime_turn_claims (
        agent_id, channel_id, client_message_id, assistant_message_id,
        owner_text, state, claim_token, lease_expires_at
      ) VALUES (
        '${AGENT_ID}', 'room-a', 'client-a',
        '22222222-2222-4222-8222-222222222222',
        'first problem', 'processing',
        '33333333-3333-4333-8333-333333333333',
        now() + interval '5 minutes'
      );
    `);

    await expect(
      (async () =>
        await dbWrite.execute(`
          INSERT INTO shared_runtime_turn_claims (
            agent_id, channel_id, client_message_id, assistant_message_id,
            owner_text, state, claim_token, lease_expires_at
          ) VALUES (
            '${AGENT_ID}', 'room-a', 'client-b',
            '44444444-4444-4444-8444-444444444444',
            'second problem', 'processing',
            '55555555-5555-4555-8555-555555555555',
            now() + interval '5 minutes'
          );
        `))(),
    ).rejects.toThrow();

    await expect(
      (async () =>
        await dbWrite.execute(`
          INSERT INTO shared_runtime_turn_claims (
            agent_id, channel_id, client_message_id, assistant_message_id,
            owner_text, state
          ) VALUES (
            '${AGENT_ID}', 'room-b', 'client-invalid',
            '66666666-6666-4666-8666-666666666666',
            'invalid state shape', 'processing'
          );
        `))(),
    ).rejects.toThrow();

    await dbWrite.execute(`DELETE FROM agent_sandboxes WHERE id = '${AGENT_ID}';`);
    const afterCascade = await dbWrite.execute(
      "SELECT client_message_id FROM shared_runtime_turn_claims;",
    );
    expect(afterCascade.rows).toEqual([]);

    await dbWrite.execute(readFileSync(fileURLToPath(downUrl), "utf8"));
    const table = await dbWrite.execute(`
      SELECT tablename
      FROM pg_tables
      WHERE tablename = 'shared_runtime_turn_claims';
    `);
    expect(table.rows).toEqual([]);
  });
});
