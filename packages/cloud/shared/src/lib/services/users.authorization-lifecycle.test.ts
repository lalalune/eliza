/**
 * User and Steward-session authorization ordering against real transactions.
 *
 * PGlite executes row locks and rollbacks while a deterministic Durable Object
 * binding records the exact state that must be durable before restrictive
 * identity and logout mutations can commit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";

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
        boundaryCalls.push({
          organizationId,
          path: new URL(request.url).pathname,
          body: (await request.json()) as Record<string, unknown>,
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
let organizations: typeof import("../../db/schemas/organizations").organizations;
let users: typeof import("../../db/schemas/users").users;
let usersService: typeof import("./users").usersService;
let runWithCloudBindingsAsync: typeof import("../runtime/cloud-bindings").runWithCloudBindingsAsync;

async function withStrongBoundary<T>(operation: () => Promise<T>): Promise<T> {
  return await runWithCloudBindingsAsync(
    {
      INFERENCE_AUTH_CACHE_ENABLED: "true",
      INFERENCE_ADMISSION_GATES: boundary,
    },
    operation,
  );
}

async function readUser() {
  return await dbWrite.query.users.findFirst({
    where: eq(users.id, USER_ID),
  });
}

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests } = await import("../../db/client"));
  ({ organizations } = await import("../../db/schemas/organizations"));
  ({ users } = await import("../../db/schemas/users"));
  ({ usersService } = await import("./users"));
  ({ runWithCloudBindingsAsync } = await import("../runtime/cloud-bindings"));

  const { pushSchema } = await import("../../db/push-schema-for-tests");
  const { apply } = await pushSchema({ organizations, users } as never, dbWrite as never);
  await apply();
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "User authorization lifecycle",
    slug: "user-authorization-lifecycle",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "steward-original",
    organization_id: ORGANIZATION_ID,
    role: "owner",
  });
}, 60_000);

beforeEach(async () => {
  boundaryCalls.length = 0;
  boundaryFailure = false;
  await dbWrite
    .update(users)
    .set({
      steward_user_id: "steward-original",
      inference_auth_revision: 0,
      inference_session_not_before: 0,
      updated_at: new Date(),
    })
    .where(eq(users.id, USER_ID));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("UsersService strong authorization lifecycle", () => {
  test("a failed logout boundary mutation rolls the not-before update back", async () => {
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() => usersService.revokeInferenceSessions(USER_ID)),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });

    expect((await readUser())?.inference_session_not_before).toBe(0);
    expect(boundaryCalls.map((call) => call.path)).toEqual([
      "/authorization/apply",
    ]);
  });

  test("logout publishes a monotonic JWT not-before revision before commit", async () => {
    const issuedBeforeLogout = Math.floor(Date.now() / 1_000);

    const updated = await withStrongBoundary(() =>
      usersService.revokeInferenceSessions(USER_ID),
    );

    expect(updated.inference_session_not_before).toBeGreaterThan(
      issuedBeforeLogout,
    );
    expect((await readUser())?.inference_session_not_before).toBe(
      updated.inference_session_not_before,
    );
    expect(boundaryCalls[0]?.body.state).toMatchObject({
      kind: "session",
      id: USER_ID,
      revision: String(updated.inference_session_not_before),
      denied: false,
    });
  });

  test("logout revokes a credential whose signed issue time is ahead of wall clock", async () => {
    const futureIssuedAt = Math.floor(Date.now() / 1_000) + 120;

    const updated = await withStrongBoundary(() =>
      usersService.revokeInferenceSessions(USER_ID, futureIssuedAt),
    );

    expect(updated.inference_session_not_before).toBe(futureIssuedAt + 1);
    expect(boundaryCalls[0]?.body.state).toMatchObject({
      kind: "session",
      revision: String(futureIssuedAt + 1),
    });
  });

  test("replaying logout cannot ratchet session denial beyond wall-clock time", async () => {
    const existingNotBefore = Math.floor(Date.now() / 1_000) + 120;
    await dbWrite
      .update(users)
      .set({ inference_session_not_before: existingNotBefore })
      .where(eq(users.id, USER_ID));

    const first = await withStrongBoundary(() =>
      usersService.revokeInferenceSessions(USER_ID),
    );
    const second = await withStrongBoundary(() =>
      usersService.revokeInferenceSessions(USER_ID),
    );

    expect(first.inference_session_not_before).toBe(existingNotBefore);
    expect(second.inference_session_not_before).toBe(existingNotBefore);
    expect((await readUser())?.inference_session_not_before).toBe(
      existingNotBefore,
    );
  });

  test("a Steward identity change cannot commit before its newer user revision", async () => {
    boundaryFailure = true;

    await expect(
      withStrongBoundary(() =>
        usersService.update(USER_ID, { steward_user_id: "steward-new" }),
      ),
    ).rejects.toMatchObject({
      code: "INFERENCE_AUTHORIZATION_BOUNDARY_REJECTED",
    });
    expect((await readUser())?.steward_user_id).toBe("steward-original");

    boundaryFailure = false;
    boundaryCalls.length = 0;
    const updated = await withStrongBoundary(() =>
      usersService.update(USER_ID, { steward_user_id: "steward-new" }),
    );
    expect(updated?.steward_user_id).toBe("steward-new");
    expect(boundaryCalls[0]?.body.state).toMatchObject({
      kind: "user",
      id: USER_ID,
      revision: String(updated?.inference_auth_revision),
      denied: false,
    });
  });
});
