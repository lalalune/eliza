/**
 * End-to-end contract for the UI-smoke stub's view-bundle route: boots the real
 * stub server (no mocks) and asserts the provenance the stub actually emits over
 * HTTP. Proves that audit mode fails observably instead of fabricating a bundle,
 * synthesized placeholders are marked on the wire, and registry fixtures match
 * the production view-capability transport contract (issue #15791).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const stubPath = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "playwright-ui-smoke-api-stub.mjs",
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function bootStub(env: Record<string, string>): Promise<{
  child: ChildProcess;
  port: number;
}> {
  const port = await freePort();
  const child = spawn("node", [stubPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELIZA_UI_SMOKE_API_PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("stub did not start in time")),
      30_000,
    );
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`stub exited before ready (code ${code})`));
    });
  });
  return { child, port };
}

let running: ChildProcess | null = null;
const tempRoots: string[] = [];
afterEach(async () => {
  running?.kill("SIGKILL");
  running = null;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function emptyBundleRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eliza-view-bundles-"));
  tempRoots.push(root);
  return root;
}

async function bundleRootWithWallet(): Promise<string> {
  const root = await emptyBundleRoot();
  const bundleDir = path.join(root, "plugin-wallet-ui", "dist", "views");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(
    path.join(bundleDir, "bundle.js"),
    "export const InventoryView = () => null;\n",
    "utf8",
  );
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseRecord(
  response: Response,
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw new Error(`expected JSON object from ${response.url}`);
  }
  return value;
}

describe("smoke view bundle provenance over HTTP (#15791)", () => {
  it("advertises canonical view capability objects", async () => {
    const bundleRoot = await emptyBundleRoot();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;

    const response = await fetch(`http://127.0.0.1:${port}/api/views`);
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.views)) {
      throw new Error("smoke view registry must return a views array");
    }

    for (const view of payload.views) {
      if (!isRecord(view) || !Array.isArray(view.capabilities)) {
        throw new Error("each smoke view must advertise capabilities");
      }
      for (const capability of view.capabilities) {
        if (!isRecord(capability)) {
          throw new Error("view capabilities must be objects");
        }
        expect(capability.id).toEqual(expect.any(String));
        expect(String(capability.id).trim()).not.toBe("");
        expect(capability.description).toEqual(expect.any(String));
        expect(String(capability.description).trim()).not.toBe("");
      }
    }
  });

  it("preserves required orchestrator task identity fields across detail, summary, and fork responses", async () => {
    const bundleRoot = await emptyBundleRoot();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_DEMO_ORCHESTRATOR: "1",
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;
    const baseUrl = `http://127.0.0.1:${port}`;
    const taskUrl = `${baseUrl}/api/orchestrator/tasks/smoke-task-1`;

    const initialResponse = await fetch(taskUrl);
    expect(initialResponse.status).toBe(200);
    const initial = await responseRecord(initialResponse);
    for (const field of [
      "latestSessionModel",
      "latestAccountProviderId",
      "latestAccountId",
      "latestAccountLabel",
      "projectId",
      "parentTaskId",
    ]) {
      expect(initial).toHaveProperty(field, null);
    }

    const identity = {
      latestSessionModel: "gpt-5-codex",
      latestAccountProviderId: "openai",
      latestAccountId: "account-primary",
      latestAccountLabel: "Primary Codex",
      projectId: "project-view-workflow",
      parentTaskId: "parent-task",
    };
    const patchResponse = await fetch(taskUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(identity),
    });
    expect(patchResponse.status).toBe(200);
    expect(await responseRecord(patchResponse)).toMatchObject(identity);

    const listResponse = await fetch(`${baseUrl}/api/orchestrator/tasks`);
    expect(listResponse.status).toBe(200);
    const list = await responseRecord(listResponse);
    if (!Array.isArray(list.tasks)) {
      throw new Error("demo orchestrator task list must contain tasks");
    }
    const summary = list.tasks.find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && candidate.id === "smoke-task-1",
    );
    expect(summary).toMatchObject(identity);

    const forkResponse = await fetch(`${taskUrl}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Forked view workflow" }),
    });
    expect(forkResponse.status).toBe(200);
    const fork = await responseRecord(forkResponse);
    expect(fork.parentTaskId).toBe("smoke-task-1");
    expect(fork.projectId).toBe(identity.projectId);
  });

  it("audit mode returns an observable failure, never a fabricated bundle", async () => {
    const bundleRoot = await emptyBundleRoot();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES: "1",
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/wallet/bundle.js`,
    );
    expect(response.headers.get("x-eliza-view-component")).toBe(
      "InventoryView",
    );
    expect(response.status).toBe(424);
    expect(response.headers.get("x-eliza-view-bundle-provenance")).toBe(
      "missing-real-bundle",
    );
    const body = await response.json();
    expect(body.provenance).toBe("missing-real-bundle");
    expect(body.expectedBundlePath).toContain(
      "plugins/plugin-wallet-ui/dist/views/bundle.js",
    );
  });

  it("non-audit marks synthesized placeholders on the wire and in bytes", async () => {
    const bundleRoot = await emptyBundleRoot();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/wallet/bundle.js`,
    );
    expect(response.status).toBe(200);
    // The component name is echoed so an audit asserts the RIGHT component's
    // surface rendered — a route cannot silently pass against the wrong one.
    expect(response.headers.get("x-eliza-view-component")).toBe(
      "InventoryView",
    );
    const provenance = response.headers.get("x-eliza-view-bundle-provenance");
    const body = await response.text();
    expect(provenance).toBe("synthesized-generic");
    expect(body).toContain("eliza-view-bundle-provenance: synthesized-generic");
    expect(body).toContain("InventoryView");
  });

  it("audit mode serves a present real bundle with exact identity headers", async () => {
    const bundleRoot = await bundleRootWithWallet();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES: "1",
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/wallet/bundle.js`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-eliza-view-bundle-provenance")).toBe(
      "real-dist",
    );
    expect(response.headers.get("x-eliza-view-component")).toBe(
      "InventoryView",
    );
    expect(response.headers.get("x-eliza-view-id")).toBe("wallet");
    expect(await response.text()).toContain("export const InventoryView");
  });
});
