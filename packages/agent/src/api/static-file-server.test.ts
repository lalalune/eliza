/**
 * Exercises dashboard HTML serving, including pre-auth capability injection
 * and real filesystem replacement of the SPA entry point.
 */

import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  injectApiBaseIntoHtml,
  resolveInjectedDashboardToken,
  serveStaticUi,
} from "./static-file-server.ts";

const TOKEN_ENV = "ELIZA_API_TOKEN";
const FORCE_ENV = "ELIZA_FORCE_INJECT_TOKEN";
const CLOUD_ENV = "ELIZA_CLOUD_PROVISIONED";
const TOKEN = "secret-full-capability-token";

describe("resolveInjectedDashboardToken", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [TOKEN_ENV, FORCE_ENV, CLOUD_ENV]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of [TOKEN_ENV, FORCE_ENV, CLOUD_ENV]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns null when not cloud-provisioned and the flag is unset (token stays out of pre-auth HTML)", () => {
    process.env[TOKEN_ENV] = TOKEN;
    expect(resolveInjectedDashboardToken()).toBeNull();
  });

  it("returns the token when ELIZA_FORCE_INJECT_TOKEN=1 and a token is configured", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[FORCE_ENV] = "1";
    expect(resolveInjectedDashboardToken()).toBe(TOKEN);
  });

  it("honors the canonical truthy set, not just '1' (e.g. 'true')", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[FORCE_ENV] = "true";
    expect(resolveInjectedDashboardToken()).toBe(TOKEN);
  });

  it("returns null when the flag is set but no token is configured (no injection of an empty token)", () => {
    process.env[FORCE_ENV] = "1";
    expect(resolveInjectedDashboardToken()).toBeNull();
  });

  it("does not inject for falsey flag values", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[FORCE_ENV] = "0";
    expect(resolveInjectedDashboardToken()).toBeNull();
  });
});

describe("injectApiBaseIntoHtml token embedding", () => {
  const html = "<!doctype html><html><head></head><body></body></html>";

  it("embeds the token into the served HTML when provided", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    expect(out).toContain(TOKEN);
    expect(out).toContain("__ELIZA_API_TOKEN__");
  });

  it("never leaks a token into the HTML when none is injected", () => {
    const out = injectApiBaseIntoHtml(
      Buffer.from(html),
      undefined,
      undefined,
    ).toString("utf-8");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("__ELIZA_API_TOKEN__");
  });
});

describe("injectApiBaseIntoHtml web-push VAPID public key", () => {
  const html = "<!doctype html><html><head></head><body></body></html>";
  const VAPID_PUBLIC = "BExamplePublicKeyBase64Url";

  it("seeds the VAPID public key into the boot config", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      webPushVapidPublicKey: VAPID_PUBLIC,
    }).toString("utf-8");
    expect(out).toContain("webPushVapidPublicKey");
    expect(out).toContain(VAPID_PUBLIC);
    expect(out).toContain("elizaos.app.boot-config");
  });

  it("merges apiBase + VAPID public key into a single boot-config write", () => {
    const out = injectApiBaseIntoHtml(
      Buffer.from(html),
      "https://proxy.example",
      {
        webPushVapidPublicKey: VAPID_PUBLIC,
      },
    ).toString("utf-8");
    expect(out).toContain("apiBase");
    expect(out).toContain("https://proxy.example");
    expect(out).toContain("webPushVapidPublicKey");
    expect(out).toContain(VAPID_PUBLIC);
    // One merged Object.assign seed, not two racing writes.
    const seedCount = out.split("__ELIZAOS_APP_BOOT_CONFIG__=next").length - 1;
    expect(seedCount).toBe(1);
  });

  it("never emits the VAPID field when none is provided", () => {
    const out = injectApiBaseIntoHtml(
      Buffer.from(html),
      undefined,
      undefined,
    ).toString("utf-8");
    expect(out).not.toContain("webPushVapidPublicKey");
  });
});

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => reject(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the static UI test server to bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

describe("serveStaticUi SPA index refresh", () => {
  it("serves a replaced index file on the next navigation even when its mtime is preserved", async () => {
    const originalCwd = process.cwd();
    const originalNodeEnv = process.env.NODE_ENV;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-static-ui-"));
    const distDir = path.join(tempRoot, "packages", "app", "dist");
    const indexPath = path.join(distDir, "index.html");
    const replacementPath = path.join(distDir, "index.next.html");
    const fixedTimestamp = new Date("2026-01-02T03:04:05.000Z");
    const firstHtml =
      '<!doctype html><html><head><script type="module" src="/assets/main-oldhash.js"></script></head></html>';
    const secondHtml =
      '<!doctype html><html><head><script type="module" src="/assets/main-newhash.js"></script></head></html>';
    let server: Server | undefined;

    try {
      await mkdir(distDir, { recursive: true });
      await writeFile(indexPath, firstHtml);
      await utimes(indexPath, fixedTimestamp, fixedTimestamp);
      process.chdir(tempRoot);
      process.env.NODE_ENV = "production";

      server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!serveStaticUi(req, res, pathname)) {
          res.writeHead(404);
          res.end("Not found");
        }
      });
      const baseUrl = await listenOnLoopback(server);

      const firstResponse = await fetch(`${baseUrl}/settings`);
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.text()).toContain("main-oldhash.js");

      await writeFile(replacementPath, secondHtml);
      await utimes(replacementPath, fixedTimestamp, fixedTimestamp);
      const firstStat = await stat(indexPath);
      await rename(replacementPath, indexPath);
      const secondStat = await stat(indexPath);
      expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);

      const secondResponse = await fetch(`${baseUrl}/chat`);
      expect(secondResponse.status).toBe(200);
      const secondBody = await secondResponse.text();
      expect(secondBody).toContain("main-newhash.js");
      expect(secondBody).not.toContain("main-oldhash.js");
    } finally {
      if (server?.listening) await closeServer(server);
      process.chdir(originalCwd);
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
