/**
 * Exercises native-composer attachment inputs through the real chat boundary
 * and real content-addressed media store. Remote coverage deliberately targets
 * loopback to prove the production SSRF guard rejects it before any fetch.
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatAttachmentInput } from "./server-types.ts";

const previousStateDir = process.env.ELIZA_STATE_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-media-test-"));
process.env.ELIZA_STATE_DIR = stateDir;

const { persistMediaBytes } = await import("./media-store.ts");
const { materializeChatAttachmentInputs, validateChatImages } = await import(
  "./server-helpers.ts"
);

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
});

describe("native composer chat attachment materialization", () => {
  it("normalizes inline and data URL bytes into the existing chat payload", async () => {
    const result = await materializeChatAttachmentInputs([
      {
        source: "inline",
        mimeType: "text/plain",
        bytesBase64: Buffer.from("inline").toString("base64"),
        name: "inline.txt",
      },
      {
        source: "data-url",
        dataUrl: "data:text/plain,hello%20world",
        name: "data.txt",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.images?.map((item) => Buffer.from(item.data, "base64").toString()),
    ).toEqual(["inline", "hello world"]);
    expect(validateChatImages(result.images)).toBeNull();
  });

  it("reads stored bytes only through a strict content-addressed URL", async () => {
    const persisted = persistMediaBytes(Buffer.from("stored"), "text/plain");
    const result = await materializeChatAttachmentInputs([
      {
        source: "stored",
        url: persisted.url,
        mimeType: "image/png",
        name: "stored.txt",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const storedImage = result.images?.[0];
    expect(storedImage).toBeDefined();
    if (!storedImage) return;
    expect(Buffer.from(storedImage.data, "base64").toString()).toBe("stored");
    expect(storedImage.mimeType).toBe("text/plain");
  });

  it("rejects forged stored handles and loopback remote sources", async () => {
    await expect(
      materializeChatAttachmentInputs([
        { source: "stored", url: "/api/media/not-a-content-hash.png" },
      ]),
    ).resolves.toMatchObject({ ok: false, status: 400 });

    await expect(
      materializeChatAttachmentInputs([
        { source: "remote", url: "http://127.0.0.1:65535/private.png" },
      ]),
    ).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("rejects malformed data URLs instead of fabricating empty media", async () => {
    await expect(
      materializeChatAttachmentInputs([
        { source: "data-url", dataUrl: "data:text/plain,%GG" },
      ]),
    ).resolves.toEqual({
      ok: false,
      status: 400,
      error: "Invalid percent-encoded data URL",
    });
  });

  it("rejects malformed source fields at the HTTP boundary", async () => {
    const malformedInput: ChatAttachmentInput = {
      source: "data-url",
      dataUrl: "data:text/plain,valid",
    };
    Reflect.set(malformedInput, "dataUrl", 42);

    await expect(
      materializeChatAttachmentInputs([malformedInput]),
    ).resolves.toMatchObject({ ok: false, status: 400 });
  });
});
