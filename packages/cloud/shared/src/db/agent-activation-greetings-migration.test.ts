/**
 * Applies and rolls back the real activation-ledger migration on PGlite.
 *
 * The proof covers journal registration, idempotent migration replay, foreign
 * keys, owner/version uniqueness, state-shape constraints, and rollback.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const upUrl = new URL("./migrations/0177_agent_activation_greetings.sql", import.meta.url);
const downUrl = new URL("./migrations/0177_agent_activation_greetings.down.sql", import.meta.url);

let dbWrite: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let databaseReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
    await dbWrite.execute("CREATE TABLE users (id uuid PRIMARY KEY);");
    await dbWrite.execute("CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY);");
    await dbWrite.execute(`INSERT INTO users (id) VALUES ('${OWNER_ID}');`);
    await dbWrite.execute(`INSERT INTO agent_sandboxes (id) VALUES ('${AGENT_ID}');`);
  } catch (error) {
    databaseReady = false;
    console.error("[agent-activation-greetings-migration] PGlite setup failed", error);
  }
}, 60_000);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("0177 agent activation greetings migration", () => {
  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((entry) => entry.tag === "0177_agent_activation_greetings")).toBe(
      true,
    );
  });

  test("applies, enforces the ledger contract, replays, and rolls back", async () => {
    expect(databaseReady).toBe(true);
    const up = readFileSync(fileURLToPath(upUrl), "utf8");
    const statements = up
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await dbWrite.execute(statement);
    }
    for (const statement of statements) {
      await dbWrite.execute(statement);
    }

    await dbWrite.execute(`
      INSERT INTO agent_activation_greetings (
        agent_id,
        owner_user_id,
        activation_version,
        conversation_id,
        message_id,
        source,
        greeting_kind,
        text,
        agent_name
      ) VALUES (
        '${AGENT_ID}',
        '${OWNER_ID}',
        '1',
        'room-a',
        '${MESSAGE_ID}',
        'agent_greeting',
        'post_sign_in_activation',
        'hello',
        'Eliza'
      );
    `);

    await expect(
      (async () =>
        await dbWrite.execute(`
          INSERT INTO agent_activation_greetings (
            agent_id,
            owner_user_id,
            activation_version,
            conversation_id,
            message_id,
            source,
            greeting_kind,
            text,
            agent_name
          ) VALUES (
            '${AGENT_ID}',
            '${OWNER_ID}',
            '1',
            'room-b',
            '44444444-4444-4444-8444-444444444444',
            'agent_greeting',
            'post_sign_in_activation',
            'duplicate',
            'Eliza'
          );
        `))(),
    ).rejects.toThrow();

    await expect(
      (async () =>
        await dbWrite.execute(`
          INSERT INTO agent_activation_greetings (
            agent_id,
            owner_user_id,
            activation_version,
            conversation_id,
            message_id,
            source,
            greeting_kind,
            text,
            agent_name
          ) VALUES (
            '55555555-5555-4555-8555-555555555555',
            '${OWNER_ID}',
            '1',
            'room-c',
            '66666666-6666-4666-8666-666666666666',
            'agent_greeting',
            'post_sign_in_activation',
            'orphan',
            'Eliza'
          );
        `))(),
    ).rejects.toThrow();

    await expect(
      (async () =>
        await dbWrite.execute(`
          UPDATE agent_activation_greetings
          SET goal_status = 'accepted',
              goal_text = 'Ship the app',
              goal_confidence = 0.9,
              goal_model = 'live-model',
              goal_recorded_at = now()
          WHERE agent_id = '${AGENT_ID}';
        `))(),
    ).rejects.toThrow();

    await expect(
      (async () =>
        await dbWrite.execute(`
          UPDATE agent_activation_greetings
          SET response_message_id = 'response-1'
          WHERE agent_id = '${AGENT_ID}';
        `))(),
    ).rejects.toThrow();

    const stored = await dbWrite.execute(
      "SELECT conversation_id, message_id, projected_at FROM agent_activation_greetings;",
    );
    expect(stored.rows).toEqual([
      {
        conversation_id: "room-a",
        message_id: MESSAGE_ID,
        projected_at: null,
      },
    ]);

    const down = readFileSync(fileURLToPath(downUrl), "utf8");
    await dbWrite.execute(down);
    const table = await dbWrite.execute(`
      SELECT tablename
      FROM pg_tables
      WHERE tablename = 'agent_activation_greetings';
    `);
    expect(table.rows).toEqual([]);
  });
});
