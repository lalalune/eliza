// @vitest-environment jsdom

/** Verifies the shared API client carries the browser session's CSRF proof on real mutation requests. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import type { AgentRequestTransport } from "./transport";

function setCookie(pair: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom exposes the synchronous cookie contract used by browser requests.
  document.cookie = pair;
}

function makeClient() {
  const request = vi.fn<AgentRequestTransport["request"]>(
    async () => new Response("{}", { status: 200 }),
  );
  const client = new ElizaClient("http://agent.example:2138");
  client.setRequestTransport({ request });
  return { client, request };
}

describe("ElizaClient browser-session CSRF", () => {
  beforeEach(() => {
    setCookie("eliza_csrf=csrf%20proof; path=/");
  });

  afterEach(() => {
    setCookie("eliza_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/");
  });

  it("mirrors the decoded cookie on mutations but not reads", async () => {
    const { client, request } = makeClient();

    await client.fetch("/api/lifeops/activity-signals", { method: "POST" });
    await client.fetch("/api/lifeops/activity-signals");

    const mutation = request.mock.calls[0]?.[1];
    const read = request.mock.calls[1]?.[1];
    expect(new Headers(mutation?.headers).get("x-eliza-csrf")).toBe(
      "csrf proof",
    );
    expect(new Headers(read?.headers).has("x-eliza-csrf")).toBe(false);
  });

  it("preserves an explicit caller-supplied CSRF proof", async () => {
    const { client, request } = makeClient();

    await client.fetch("/api/things", {
      method: "PATCH",
      headers: { "X-Eliza-CSRF": "caller-proof" },
    });

    expect(
      new Headers(request.mock.calls[0]?.[1].headers).get("x-eliza-csrf"),
    ).toBe("caller-proof");
  });
});
