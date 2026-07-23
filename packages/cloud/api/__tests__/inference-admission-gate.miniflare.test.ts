/**
 * Runs the production admission class inside Miniflare to prove Cloudflare's
 * real Durable Object storage and request serialization preserve spend holds.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

let miniflare: Miniflare;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL(
        "../test/fixtures/inference-admission-gate-worker.ts",
        import.meta.url,
      ).pathname,
    ],
    format: "esm",
    target: "browser",
    conditions: ["worker", "browser"],
    plugins: [
      {
        name: "admission-runtime-boundaries",
        setup(build) {
          build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
            path: new URL("../src/stubs/elizaos-core.ts", import.meta.url)
              .pathname,
          }));
          build.onLoad(
            { filter: /packages\/core\/src\/index\.node\.ts$/ },
            () => ({
              loader: "ts",
              contents: readFileSync(
                new URL("../src/stubs/elizaos-core.ts", import.meta.url),
                "utf8",
              ),
            }),
          );
          build.onLoad(
            {
              filter:
                /packages\/cloud\/shared\/src\/lib\/services\/inference-authorization-boundary\.ts$/,
            },
            (args) => ({
              loader: "ts",
              contents: readFileSync(args.path, "utf8").replace(
                'import { ElizaError } from "@elizaos/core";',
                `class ElizaError extends Error {
                  readonly code: string;
                  readonly context?: Record<string, unknown>;
                  readonly severity?: "ephemeral" | "fatal";
                  constructor(
                    message: string,
                    options: {
                      code: string;
                      cause?: unknown;
                      context?: Record<string, unknown>;
                      severity?: "ephemeral" | "fatal";
                    },
                  ) {
                    super(
                      message,
                      options.cause === undefined
                        ? undefined
                        : { cause: options.cause },
                    );
                    this.code = options.code;
                    this.context = options.context;
                    this.severity = options.severity;
                  }
                }`,
              ),
            }),
          );
          build.onLoad(
            { filter: /packages\/cloud\/shared\/src\/db\/client\.ts$/ },
            () => ({
              loader: "ts",
              contents: `
              export async function runWithDbCacheAsync<T>(operation: () => Promise<T>): Promise<T> {
                return await operation();
              }
            `,
            }),
          );
          build.onLoad(
            {
              filter:
                /packages\/cloud\/shared\/src\/lib\/runtime\/cloud-bindings\.ts$/,
            },
            () => ({
              loader: "ts",
              contents: `
                export async function runWithCloudBindingsAsync<T>(
                  _bindings: Record<string, unknown>,
                  operation: () => Promise<T>,
                ): Promise<T> {
                  return await operation();
                }
                export function getCloudAwareEnv(): Record<string, string> {
                  return { INFERENCE_AUTH_CACHE_ENABLED: "true" };
                }
                export function getCloudBinding<T>(): T | undefined {
                  return undefined;
                }
              `,
            }),
          );
          build.onLoad(
            {
              filter:
                /packages\/cloud\/shared\/src\/lib\/services\/inference-admission-recovery\.ts$/,
            },
            () => ({
              loader: "ts",
              contents: `
                export async function recoverExpiredInferenceAdmissionLease(): Promise<never> {
                  throw new Error("alarm recovery is outside this serialization test");
                }
              `,
            }),
          );
          build.onLoad(
            { filter: /packages\/cloud\/shared\/src\/lib\/utils\/logger\.ts$/ },
            () => ({
              loader: "ts",
              contents: `
                export const logger = {
                  debug() {},
                  info() {},
                  warn() {},
                  error() {},
                };
              `,
            }),
          );
        },
      },
    ],
  });
  if (!build.success) {
    throw new AggregateError(
      build.logs,
      "Failed to bundle admission test Worker",
    );
  }
  const output = build.outputs[0];
  if (!output) throw new Error("Admission test Worker bundle was not emitted");

  miniflare = new Miniflare({
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    script: await output.text(),
    durableObjects: {
      TEST_ADMISSION_GATE: {
        className: "InferenceAdmissionGate",
        useSQLite: true,
      },
    },
    bindings: {
      INFERENCE_AUTH_CACHE_ENABLED: "true",
    },
  });
});

afterAll(async () => {
  await miniflare?.dispose();
});

async function post(
  path: string,
  body: Record<string, unknown>,
  organizationId = "org-miniflare",
): Promise<{ readonly status: number; text(): Promise<string> }> {
  const response = await miniflare.dispatchFetch(`https://gate.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-organization-id": organizationId,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: async () => await response.text(),
  };
}

test("real Durable Object serialization prevents concurrent overspend", async () => {
  const authorization = {
    v: 1,
    organizationId: "org-miniflare",
    organizationRevision: "1",
    userId: "00000000-0000-4000-8000-000000000002",
    userRevision: "1",
    credential: {
      kind: "api_key",
      id: "00000000-0000-4000-8000-000000000003",
      fingerprint: "a".repeat(64),
      revision: "1",
      expiresAt: null,
    },
  };
  expect(
    (
      await post("/authorization/initialize", {
        organizationId: "org-miniflare",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post("/hydrate", {
        balanceUsd: 10,
        balanceAt: Date.now(),
        balanceRevision: "1",
      })
    ).status,
  ).toBe(200);

  const [first, second] = await Promise.all([
    post("/lease", {
      organizationId: "org-miniflare",
      requestId: "request-a",
      balanceUsd: 10,
      balanceRevision: "1",
      estimatedCostUsd: 7,
      authorization,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId: "org-miniflare",
        userId: authorization.userId,
        requestId: "request-a",
        model: "test-model",
        provider: "test-provider",
        billingSource: "test",
        description: "Miniflare admission test",
        accounting: { kind: "direct_debit" },
      },
    }),
    post("/lease", {
      organizationId: "org-miniflare",
      requestId: "request-b",
      balanceUsd: 10,
      balanceRevision: "1",
      estimatedCostUsd: 7,
      authorization,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId: "org-miniflare",
        userId: authorization.userId,
        requestId: "request-b",
        model: "test-model",
        provider: "test-provider",
        billingSource: "test",
        description: "Miniflare admission test",
        accounting: { kind: "direct_debit" },
      },
    }),
  ]);

  if (first.status === 400 || second.status === 400) {
    throw new Error(
      `Unexpected gate validation response: ${first.status} ${await first.text()} / ${second.status} ${await second.text()}`,
    );
  }
  expect([first.status, second.status].sort()).toEqual([200, 402]);
}, 30_000);

test("real Durable Object rejects every stale authorization after revocation", async () => {
  const organizationId = "org-auth-miniflare";
  const userId = "00000000-0000-4000-8000-000000000002";
  const authorization = {
    v: 1,
    organizationId,
    organizationRevision: "1",
    userId,
    userRevision: "1",
    credential: {
      kind: "api_key",
      id: "00000000-0000-4000-8000-000000000003",
      fingerprint: "a".repeat(64),
      revision: "1",
      expiresAt: null,
    },
  };
  expect(
    (
      await post(
        "/hydrate",
        {
          balanceUsd: 10,
          balanceRevision: "1",
        },
        organizationId,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/authorization/initialize",
        { organizationId },
        organizationId,
      )
    ).status,
  ).toBe(200);

  const requestIds = Array.from(
    { length: 32 },
    (_, index) => `stale-cache-${index}`,
  );
  for (const requestId of requestIds) {
    expect(
      (
        await post(
          "/lease",
          {
            organizationId,
            requestId,
            balanceUsd: 10,
            balanceRevision: "1",
            estimatedCostUsd: 0.01,
            authorization,
            recovery: {
              version: 1,
              kind: "organization",
              organizationId,
              userId,
              requestId,
              model: "test-model",
              provider: "test-provider",
              billingSource: "test",
              description: "stale authorization race",
              accounting: { kind: "direct_debit" },
            },
          },
          organizationId,
        )
      ).status,
    ).toBe(200);
  }
  expect(
    (
      await post(
        "/authorization/apply",
        {
          organizationId,
          state: {
            kind: "user",
            id: userId,
            revision: "2",
            denied: true,
          },
        },
        organizationId,
      )
    ).status,
  ).toBe(200);

  const staleDispatches = await Promise.all(
    requestIds.map((requestId) =>
      post("/dispatch", { requestId }, organizationId),
    ),
  );
  expect(staleDispatches.every((response) => response.status === 403)).toBe(
    true,
  );
}, 30_000);

test("real Durable Object authorizes zero-rated dispatch without a balance ledger", async () => {
  const organizationId = "org-auth-only-miniflare";
  const userId = "00000000-0000-4000-8000-000000000012";
  const authorization = {
    v: 1,
    organizationId,
    organizationRevision: "1",
    userId,
    userRevision: "1",
    credential: {
      kind: "api_key",
      id: "00000000-0000-4000-8000-000000000013",
      fingerprint: "b".repeat(64),
      revision: "1",
      expiresAt: null,
    },
  };
  expect(
    (
      await post(
        "/authorization/initialize",
        { organizationId },
        organizationId,
      )
    ).status,
  ).toBe(200);

  const authorized = await post(
    "/authorization/dispatch",
    { organizationId, authorization },
    organizationId,
  );
  expect(authorized.status).toBe(200);
  expect(JSON.parse(await authorized.text())).toEqual({
    authorized: true,
    authCheckedVersion: 1,
  });

  expect(
    (
      await post(
        "/authorization/apply",
        {
          organizationId,
          state: {
            kind: "credential",
            id: authorization.credential.id,
            credentialKind: "api_key",
            fingerprint: authorization.credential.fingerprint,
            revision: "2",
            denied: true,
            userId,
            expiresAt: null,
          },
        },
        organizationId,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/authorization/dispatch",
        { organizationId, authorization },
        organizationId,
      )
    ).status,
  ).toBe(403);
}, 30_000);
