/**
 * Applies the inference-authorization migration to real PGlite storage and
 * proves each security-sensitive table advances only its own monotonic
 * revision while existing rows receive safe initial values.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_TAG = "0183_inference_authorization_revisions";
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY_ID = "33333333-3333-4333-8333-333333333333";

let client: PGlite;

function migrationStatements(): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function revisions(): Promise<{
  organization: number;
  user: number;
  sessionNotBefore: number;
  apiKey: number;
}> {
  const organization = await client.query<{ inference_auth_revision: string }>(
    "SELECT inference_auth_revision FROM organizations WHERE id = $1",
    [ORGANIZATION_ID],
  );
  const user = await client.query<{
    inference_auth_revision: string;
    inference_session_not_before: string;
  }>(
    `SELECT inference_auth_revision, inference_session_not_before
       FROM users WHERE id = $1`,
    [USER_ID],
  );
  const apiKey = await client.query<{ inference_auth_revision: string }>(
    "SELECT inference_auth_revision FROM api_keys WHERE id = $1",
    [API_KEY_ID],
  );
  return {
    organization: Number(organization.rows[0]?.inference_auth_revision),
    user: Number(user.rows[0]?.inference_auth_revision),
    sessionNotBefore: Number(user.rows[0]?.inference_session_not_before),
    apiKey: Number(apiKey.rows[0]?.inference_auth_revision),
  };
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE users (
      id uuid PRIMARY KEY,
      name text,
      steward_user_id text,
      organization_id uuid REFERENCES organizations(id),
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamp
    );

    CREATE TABLE api_keys (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      key_hash text NOT NULL,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid NOT NULL REFERENCES users(id),
      is_active boolean NOT NULL DEFAULT true,
      expires_at timestamp,
      deleted_at timestamp
    );

    INSERT INTO organizations (id, name)
    VALUES ('${ORGANIZATION_ID}', 'Migration proof');

    INSERT INTO users (id, name, organization_id)
    VALUES ('${USER_ID}', 'Migration user', '${ORGANIZATION_ID}');

    INSERT INTO api_keys (id, name, key_hash, organization_id, user_id)
    VALUES (
      '${API_KEY_ID}',
      'Migration key',
      '${"a".repeat(64)}',
      '${ORGANIZATION_ID}',
      '${USER_ID}'
    );
  `);
  for (const statement of migrationStatements()) {
    await client.exec(statement);
  }
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe("0183 inference authorization revisions", () => {
  test("is registered immediately after the latest predecessor", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION_TAG);

    const predecessor = journal.entries.find(
      (candidate) => candidate.tag === "0182_warm_claim_credential_fence",
    );
    expect(entry?.tag).toBe(MIGRATION_TAG);
    expect(entry?.idx).toBe((predecessor?.idx ?? -1) + 1);
    expect(entry?.when).toBeGreaterThan(predecessor?.when ?? 0);
  });

  test("backfills existing rows without revoking them", async () => {
    expect(await revisions()).toEqual({
      organization: 0,
      user: 0,
      sessionNotBefore: 0,
      apiKey: 0,
    });
  });

  test("advances organization, user, and credential revisions independently", async () => {
    await client.query("UPDATE organizations SET name = 'Cosmetic rename' WHERE id = $1", [
      ORGANIZATION_ID,
    ]);
    await client.query("UPDATE users SET name = 'Cosmetic rename' WHERE id = $1", [USER_ID]);
    await client.query("UPDATE api_keys SET name = 'Cosmetic rename' WHERE id = $1", [API_KEY_ID]);
    expect(await revisions()).toEqual({
      organization: 0,
      user: 0,
      sessionNotBefore: 0,
      apiKey: 0,
    });

    await client.query("UPDATE organizations SET is_active = false WHERE id = $1", [
      ORGANIZATION_ID,
    ]);
    const afterOrganization = await revisions();
    expect(afterOrganization.organization).toBeGreaterThan(0);
    expect(afterOrganization.user).toBe(0);
    expect(afterOrganization.apiKey).toBe(0);

    await client.query("UPDATE users SET organization_id = NULL WHERE id = $1", [USER_ID]);
    const afterUser = await revisions();
    expect(afterUser.user).toBeGreaterThan(afterOrganization.organization);
    expect(afterUser.apiKey).toBe(0);

    await client.query("UPDATE users SET steward_user_id = 'steward-migrated' WHERE id = $1", [
      USER_ID,
    ]);
    const afterIdentity = await revisions();
    expect(afterIdentity.user).toBeGreaterThan(afterUser.user);

    await client.query("UPDATE api_keys SET is_active = false WHERE id = $1", [API_KEY_ID]);
    const afterCredential = await revisions();
    expect(afterCredential.apiKey).toBeGreaterThan(afterIdentity.user);
    expect(afterCredential.sessionNotBefore).toBe(0);
  });

  test("never moves a revision backward when a service supplies its own increment", async () => {
    const before = await revisions();
    await client.query(
      `UPDATE users
          SET is_active = false,
              inference_auth_revision = inference_auth_revision + 1
        WHERE id = $1`,
      [USER_ID],
    );
    const after = await revisions();
    expect(after.user).toBeGreaterThan(before.user);

    await client.query(
      `UPDATE users
          SET inference_session_not_before = $2
        WHERE id = $1`,
      [USER_ID, Math.floor(Date.now() / 1_000) + 1],
    );
    expect((await revisions()).sessionNotBefore).toBeGreaterThan(0);
  });
});
