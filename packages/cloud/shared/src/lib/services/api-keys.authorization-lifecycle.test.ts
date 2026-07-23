/**
 * API-key lifecycle ordering against real transactional Postgres semantics.
 *
 * PGlite executes the service's row locks, revision updates, commits, and
 * rollbacks. A deterministic Durable Object binding records the authorization
 * mutation boundary without replacing the database behavior under test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";
const KEY_ID = "00000000-0000-4000-8000-0000000000c1";
const KEY_HASH = "a".repeat(64);

interface BoundaryCall {
  organizationId: string;
  path: string;
  body: Record<string, unknown>;
}

const boundaryCalls: BoundaryCall[] = [];
let boundaryFailure = false;

const boundary: RuntimeDurableObjectNamespace = {
  getByName(organizationId) {
    return {
      async fetch(input) {
        const request = input instanceof Request ? input : new Request(input);
        const body = (await request.json()) as Record<string, unknown>;
        boundaryCalls.push({
          organizationId,
          path: new URL(request.url).pathname,
          body,
        });
        if (boundaryFailure) {
          return Response.json({ applied: false }, { status: 503 });
        }
        return Response.json({
          applied: true,
          authBoundaryVersion: 1,
        });
      },
    };
  },
};

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let apiKeys: typeof import("../../db/schemas/api-keys").apiKeys;
let organizations: typeof import("../../db/schemas/organizations").organizations;
let users: typeof import("../../db/schemas/users").users;
let apiKeysService: typeof import("./api-keys").apiKeysService;
let runWithCloudBindingsAsync: typeof import("../runtime/cloud-bindings").runWithCloudBindingsAsync;
let cache: typeof import("../cache/client").cache;

async function withStrongBoundary<T>(operation: () => Promise<T>): Promise<T> {
  return await runWithCloudBindingsAsync(
    {
      INFERENCE_AUTH_CACHE_ENABLED: "true",
      INFERENCE_ADMISSION_GATES: boundary,
    },
    operation,
  );
}

async function insertKey(
  params: { id?: string; hash?: string; name?: string; active?: boolean } = {},
): Promise<void> {
  await dbWrite.insert(apiKeys).values({
    id: params.id ?? KEY_ID,
    name: params.name ?? "test-key",
    key_hash: params.hash ?? KEY_HASH,
    key_prefix: "eliza_test",
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    is_active: params.active ?? true,
  });
}

async function readKey(id = KEY_ID) {
  return await dbWrite.query.apiKeys.findFirst({
    where: eq(apiKeys.id, id),
  });
}

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests } = await import("../../db/client"));
  ({ apiKeys } = await import("../../db/schemas/api-keys"));
  ({ organizations } = await import("../../db/schemas/organizations"));
  ({ users } = await import("../../db/schemas/users"));
  ({ apiKeysService } = await import("./api-keys"));
  ({ runWithCloudBindingsAsync } = await import("../runtime/cloud-bindings"));
  ({ cache } = await import("../cache/client"));

  const { pushSchema } = await import("../../db/push-schema-for-tests");
  const { apply } = await pushSchema({ organizations, users, apiKeys } as never, dbWrite as never);
  await apply();
  await dbWrite.execute(sql`
    CREATE SEQUENCE IF NOT EXISTS inference_authorization_revision_seq AS bigint
  `);
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Authorization lifecycle",
    slug: "authorization-lifecycle",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "steward-authorization-lifecycle",
    email: "authorization-lifecycle@example.com",
    organization_id: ORGANIZATION_ID,
    role: "owner",
  });
}, 60_000);

beforeEach(async () => {
  boundaryCalls.length = 0;
  boundaryFailure = false;
  await dbWrite.delete(apiKeys);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("ApiKeysService strong authorization lifecycle", () => {
  test("a failed restrictive boundary update rolls the database mutation back", async () => {
    await insertKey();
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() => apiKeysService.update(KEY_ID, { is_active: false })),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });

    const stored = await readKey();
    expect(stored?.is_active).toBe(true);
    expect(stored?.inference_auth_revision).toBe(0);
    expect(boundaryCalls.map((call) => call.path)).toEqual(["/authorization/apply-batch"]);
  });

  test("a restrictive update is acknowledged before its transaction commits", async () => {
    await insertKey();

    const updated = await withStrongBoundary(() =>
      apiKeysService.update(KEY_ID, { is_active: false }),
    );

    expect(updated?.is_active).toBe(false);
    expect(updated?.inference_auth_revision).toBeGreaterThan(0);
    const state = (boundaryCalls[0]?.body.states as Array<Record<string, unknown>>)?.[0];
    expect(boundaryCalls[0]?.path).toBe("/authorization/apply-batch");
    expect(state?.id).toBe(KEY_ID);
    expect(state?.denied).toBe(true);
    expect(state?.revision).toBe(String(updated?.inference_auth_revision));
  });

  test("cache cleanup failure cannot undo a boundary-acknowledged revocation", async () => {
    await insertKey();
    const cleanup = spyOn(cache, "delConfirmed").mockResolvedValue(false);
    try {
      await expect(
        withStrongBoundary(() => apiKeysService.update(KEY_ID, { is_active: false })),
      ).resolves.toMatchObject({ is_active: false });
    } finally {
      cleanup.mockRestore();
    }

    expect((await readKey())?.is_active).toBe(false);
    expect(boundaryCalls[0]?.path).toBe("/authorization/apply-batch");
  });

  test("a failed permissive update remains committed but is not reported as success", async () => {
    await insertKey({ active: false });
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() => apiKeysService.update(KEY_ID, { is_active: true })),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });

    const stored = await readKey();
    expect(stored?.is_active).toBe(true);
    expect(stored?.inference_auth_revision).toBeGreaterThan(0);
    expect(boundaryCalls.map((call) => call.path)).toEqual(["/authorization/apply"]);

    boundaryFailure = false;
    boundaryCalls.length = 0;
    const retried = await withStrongBoundary(() =>
      apiKeysService.update(KEY_ID, { is_active: true }),
    );
    expect(retried?.is_active).toBe(true);
    expect(boundaryCalls.map((call) => call.path)).toEqual(["/authorization/apply"]);
  });

  test("credential rotation denies the old fingerprint before activating the new one", async () => {
    await insertKey();
    const rotatedHash = "b".repeat(64);

    const updated = await withStrongBoundary(() =>
      apiKeysService.update(KEY_ID, { key_hash: rotatedHash }),
    );

    expect(updated?.key_hash).toBe(rotatedHash);
    expect(boundaryCalls.map((call) => call.path)).toEqual([
      "/authorization/apply-batch",
      "/authorization/apply",
    ]);
    const denied = (boundaryCalls[0]?.body.states as Array<Record<string, unknown>>)?.[0];
    const activated = boundaryCalls[1]?.body.state as Record<string, unknown>;
    expect(denied?.fingerprint).toBe(KEY_HASH);
    expect(denied?.denied).toBe(true);
    expect(activated?.fingerprint).toBe(rotatedHash);
    expect(activated?.denied).toBe(false);
    expect(BigInt(activated?.revision as string)).toBeGreaterThan(
      BigInt(denied?.revision as string),
    );
    expect(activated?.revision).toBe(String(updated?.inference_auth_revision));
  });

  test("delete rolls back unless its deny state is durable", async () => {
    await insertKey();
    boundaryFailure = true;

    await expect(withStrongBoundary(() => apiKeysService.delete(KEY_ID))).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });
    expect(await readKey()).toBeDefined();

    boundaryFailure = false;
    boundaryCalls.length = 0;
    await withStrongBoundary(() => apiKeysService.delete(KEY_ID));

    expect(await readKey()).toBeUndefined();
    expect(boundaryCalls[0]?.path).toBe("/authorization/apply");
    expect((boundaryCalls[0]?.body.state as Record<string, unknown>)?.denied).toBe(true);
  });

  test("bulk revocation rolls every key back when the state batch fails", async () => {
    const secondId = "00000000-0000-4000-8000-0000000000c2";
    await insertKey({ name: "shared-name" });
    await insertKey({
      id: secondId,
      hash: "b".repeat(64),
      name: "shared-name",
    });
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() => apiKeysService.deactivateUserKeysByName(USER_ID, "shared-name")),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });

    expect((await readKey())?.is_active).toBe(true);
    expect((await readKey(secondId))?.is_active).toBe(true);
    const states = boundaryCalls[0]?.body.states as unknown[];
    expect(states).toHaveLength(2);
  });

  test("organization-scoped deactivation publishes every deny before commit", async () => {
    const secondId = "00000000-0000-4000-8000-0000000000c2";
    await insertKey();
    await insertKey({
      id: secondId,
      hash: "b".repeat(64),
    });

    await withStrongBoundary(() =>
      apiKeysService.deactivateByUserAndOrganization(USER_ID, ORGANIZATION_ID),
    );

    expect((await readKey())?.is_active).toBe(false);
    expect((await readKey(secondId))?.is_active).toBe(false);
    const states = boundaryCalls[0]?.body.states as Array<Record<string, unknown>>;
    expect(states).toHaveLength(2);
    expect(states.every((state) => state.denied === true)).toBe(true);
  });

  test("agent-key revocation rolls deletion back until its denies are acknowledged", async () => {
    const sandboxId = "00000000-0000-4000-8000-0000000000d1";
    await insertKey({ name: `agent-sandbox:${sandboxId}` });
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() => apiKeysService.revokeForAgent(sandboxId)),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });
    expect(await readKey()).toBeDefined();

    boundaryFailure = false;
    boundaryCalls.length = 0;
    await withStrongBoundary(() => apiKeysService.revokeForAgent(sandboxId));
    expect(await readKey()).toBeUndefined();
    const states = boundaryCalls[0]?.body.states as Array<Record<string, unknown>>;
    expect(states[0]?.denied).toBe(true);
  });

  test("creation does not reveal plaintext before boundary activation", async () => {
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() =>
        apiKeysService.create({
          name: "not-revealed",
          organization_id: ORGANIZATION_ID,
          user_id: USER_ID,
          is_active: true,
        }),
      ),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });

    const rows = await dbWrite.select().from(apiKeys).where(eq(apiKeys.name, "not-revealed"));
    expect(rows).toHaveLength(1);
    expect(boundaryCalls.map((call) => call.path)).toEqual(["/authorization/apply"]);
  });

  test("default provisioning retries boundary activation without minting a duplicate", async () => {
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() => apiKeysService.provisionDefaultApiKey(USER_ID, ORGANIZATION_ID)),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });
    let rows = await dbWrite.select().from(apiKeys).where(eq(apiKeys.name, "Default API Key"));
    expect(rows).toHaveLength(1);

    boundaryFailure = false;
    boundaryCalls.length = 0;
    await withStrongBoundary(() => apiKeysService.provisionDefaultApiKey(USER_ID, ORGANIZATION_ID));
    rows = await dbWrite.select().from(apiKeys).where(eq(apiKeys.name, "Default API Key"));
    expect(rows).toHaveLength(1);
    expect(boundaryCalls.map((call) => call.path)).toEqual(["/authorization/apply"]);
  });
});
