/**
 * Token-injection gating for the served dashboard HTML.
 *
 * The dashboard `index.html` is served pre-auth, so embedding the
 * full-capability API token into it is a capability grant. These tests pin the
 * gate: managed Cloud HTML never receives the token, including when a stale
 * force-injection flag is present. Only a self-hosting operator's explicit
 * `ELIZA_FORCE_INJECT_TOKEN` opt-in may embed it.
 */

import type http from "node:http";
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

  it("returns null for a managed Cloud container even when force injection is set", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[CLOUD_ENV] = "1";
    process.env[FORCE_ENV] = "1";
    expect(resolveInjectedDashboardToken()).toBeNull();
  });

  it("serves managed SPA HTML without the raw token or bootstrap marker", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[CLOUD_ENV] = "1";
    process.env[FORCE_ENV] = "1";

    let status = 0;
    let body = "";
    const response = {
      writeHead(code: number) {
        status = code;
        return response;
      },
      end(chunk?: Buffer | string) {
        body = chunk?.toString() ?? "";
        return response;
      },
    };
    const handled = serveStaticUi(
      { method: "GET" } as http.IncomingMessage,
      response as unknown as http.ServerResponse,
      "/",
      {
        root: "/nonexistent-managed-ui-root",
        indexHtml: Buffer.from(
          "<!doctype html><html><head></head><body>managed dashboard</body></html>",
        ),
      },
    );

    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("__ELIZA_API_TOKEN__");
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
