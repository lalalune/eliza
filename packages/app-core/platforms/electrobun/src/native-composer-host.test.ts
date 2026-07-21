/** Exercises Electrobun composer handoff with real local file bytes. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeNativeComposerOperation,
  drainNativeComposerOperations,
  enqueueNativeComposerOperations,
  NATIVE_COMPOSER_SCHEMA,
  nativeComposerOperationsFromDeepLink,
  publishNativeComposerEvent,
  readLatestNativeComposerEvent,
  resetNativeComposerHostForTests,
} from "./native-composer-host";

let tempDir = "";

beforeEach(() => {
  resetNativeComposerHostForTests();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-native-composer-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("nativeComposerOperationsFromDeepLink", () => {
  it("prefills attacker-authored text without auto-sending it", () => {
    const operations = nativeComposerOperationsFromDeepLink(
      "elizaos://chat?text=review%20me&assistant.launchId=launch-1",
    );

    expect(operations).toEqual([
      { type: "text.set", opId: "launch-1:text", text: "review me" },
      {
        type: "focus.set",
        opId: "launch-1:focus",
        focused: true,
        keyboard: "shown",
      },
    ]);
    expect(operations).not.toContainEqual(
      expect.objectContaining({ type: "send" }),
    );
  });

  it("reads OS-delivered file bytes into the inline attachment contract", () => {
    const filePath = path.join(tempDir, "proof.txt");
    fs.writeFileSync(filePath, "real desktop bytes");
    const url = new URL("elizaos://share");
    url.searchParams.set("file", filePath);
    url.searchParams.set("assistant.launchId", "share-1");

    const operations = nativeComposerOperationsFromDeepLink(url.href);

    expect(operations[0]).toEqual({
      type: "attachment.add",
      opId: "share-1:attachment:0",
      attachmentId: "share-1:attachment:0",
      attachment: {
        source: "inline",
        mimeType: "text/plain",
        bytesBase64: Buffer.from("real desktop bytes").toString("base64"),
        name: "proof.txt",
      },
    });
  });

  it("rejects relative and unsupported files instead of dropping them", () => {
    expect(() =>
      nativeComposerOperationsFromDeepLink("elizaos://share?file=relative.txt"),
    ).toThrow("only absolute");

    const filePath = path.join(tempDir, "proof.exe");
    fs.writeFileSync(filePath, "not allowed");
    const url = new URL("elizaos://share");
    url.searchParams.set("file", filePath);
    expect(() => nativeComposerOperationsFromDeepLink(url.href)).toThrow(
      "unsupported",
    );
  });

  it("ignores non-composer routes and rejects attachment floods before reads", () => {
    expect(
      nativeComposerOperationsFromDeepLink(
        "elizaos://lifeops/task/new?text=buy%20milk",
      ),
    ).toEqual([]);

    const filePath = path.join(tempDir, "proof.txt");
    fs.writeFileSync(filePath, "bounded bytes");
    const url = new URL("elizaos://share");
    for (let index = 0; index < 5; index++) {
      url.searchParams.append("file", filePath);
    }
    expect(() => nativeComposerOperationsFromDeepLink(url.href)).toThrow(
      "at most 4 attachments",
    );
  });
});

describe("native composer host state", () => {
  it("redelivers queued operations until the renderer acknowledges them", () => {
    enqueueNativeComposerOperations([{ type: "text.set", opId: "one" }]);
    const first = drainNativeComposerOperations();
    expect(first.schema).toBe(NATIVE_COMPOSER_SCHEMA);
    expect(first.operations).toEqual([
      {
        deliveryId: expect.any(String),
        operation: { type: "text.set", opId: "one" },
      },
    ]);
    expect(drainNativeComposerOperations()).toEqual(first);
    const delivery = first.operations[0] as { deliveryId: string };
    expect(
      acknowledgeNativeComposerOperation({
        schema: NATIVE_COMPOSER_SCHEMA,
        acknowledgment: {
          deliveryId: delivery.deliveryId,
          disposition: "persisted",
          resultStatus: "applied",
        },
      }),
    ).toEqual({ removed: true });
    expect(drainNativeComposerOperations().operations).toEqual([]);
  });

  it("disposes an invalid frame only after a typed renderer rejection", () => {
    const enqueued = enqueueNativeComposerOperations([{ malformed: true }]);
    const delivery = enqueued.operations[0] as { deliveryId: string };
    expect(
      acknowledgeNativeComposerOperation({
        schema: NATIVE_COMPOSER_SCHEMA,
        acknowledgment: {
          deliveryId: delivery.deliveryId,
          disposition: "rejected",
          resultStatus: "invalid-input",
          reason: "operation type is missing",
        },
      }),
    ).toEqual({ removed: true });
    expect(drainNativeComposerOperations().operations).toEqual([]);
  });

  it("validates and consumes renderer events", () => {
    const event = { type: "draft.changed", draft: { text: "hello" } };
    expect(
      publishNativeComposerEvent({
        schema: NATIVE_COMPOSER_SCHEMA,
        event,
      }),
    ).toEqual({ ok: true });
    expect(readLatestNativeComposerEvent("draft.changed")).toEqual(event);
    expect(() =>
      publishNativeComposerEvent({ schema: "wrong", event }),
    ).toThrow("unsupported native composer schema");
  });
});
