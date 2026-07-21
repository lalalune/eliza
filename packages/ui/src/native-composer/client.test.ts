/**
 * Client-boundary tests: malformed native input degrades to a typed rejection
 * (never a throw), events are emitted toward the shell, and serialize/hydrate
 * preserves the draft + idempotency ledger + offline queue across a reload — so a
 * duplicate op still no-ops and a deferred send still replays after reconnect.
 */

import { describe, expect, it } from "vitest";
import {
  createComposerBridgeClient,
  decodeComposerBridgeSnapshot,
} from "./client";
import type { ComposerEvent } from "./contract";
import { NATIVE_COMPOSER_SCHEMA } from "./contract";
import { DEFAULT_COMPOSER_LIMITS } from "./reduce";

describe("createComposerBridgeClient — boundary + events", () => {
  it("degrades malformed raw input to invalid-input, never throws", () => {
    const client = createComposerBridgeClient();
    const r = client.dispatchRaw({ type: "text.set", opId: "a", text: 9 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.reason).toBe("invalid-input");
      expect(r.opId).toBe("a");
    }
  });

  it("degrades an unusable batch envelope to one invalid-input result", () => {
    const client = createComposerBridgeClient();
    expect(
      client.dispatchRawStream({ schema: "wrong", operations: [] }),
    ).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: "invalid-input",
      }),
    ]);
  });

  it("emits draft.changed + focus.changed for a focus op", () => {
    const client = createComposerBridgeClient();
    const events: ComposerEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.dispatchRaw({
      type: "focus.set",
      opId: "f",
      focused: true,
      keyboard: "shown",
    });
    expect(events.map((e) => e.type)).toEqual([
      "draft.changed",
      "focus.changed",
    ]);
  });

  it("emits voice.state for a voice op and send.result on completion", () => {
    const client = createComposerBridgeClient();
    const events: ComposerEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.dispatchRaw({ type: "text.set", opId: "t", text: "hi" });
    client.dispatchRaw({ type: "voice.handoff", opId: "v", phase: "start" });
    client.dispatchRaw({ type: "send", opId: "s" });
    client.completeSend("s", { ok: true, messageId: "m1" });
    expect(events.some((e) => e.type === "voice.state")).toBe(true);
    const sendResult = events.find((e) => e.type === "send.result");
    expect(sendResult).toBeDefined();
    if (sendResult && sendResult.type === "send.result")
      expect(sendResult.outcome.ok).toBe(true);
    expect(client.getDraft().text).toBe(""); // cleared on successful send
  });

  it("ignores a stale or duplicated send completion", () => {
    const client = createComposerBridgeClient();
    const events: ComposerEvent[] = [];
    client.subscribe((event) => events.push(event));
    client.dispatchRaw({ type: "text.set", opId: "t", text: "hi" });
    client.dispatchRaw({ type: "send", opId: "s" });

    client.completeSend("stale", { ok: true, messageId: "wrong" });
    expect(client.getDraft().text).toBe("hi");
    expect(events.filter((event) => event.type === "send.result")).toHaveLength(
      0,
    );

    client.completeSend("s", { ok: true, messageId: "m1" });
    client.completeSend("s", { ok: true, messageId: "m1" });
    expect(events.filter((event) => event.type === "send.result")).toHaveLength(
      1,
    );
  });
});

describe("createComposerBridgeClient — reload durability", () => {
  it("strictly validates persisted snapshots before hydration", () => {
    const valid = createComposerBridgeClient().serialize();
    expect(decodeComposerBridgeSnapshot(valid)).toEqual({
      ok: true,
      snapshot: valid,
    });
    expect(
      decodeComposerBridgeSnapshot({
        ...valid,
        draft: { ...valid.draft, revision: -1 },
      }),
    ).toEqual({ ok: false, message: "snapshot draft is invalid" });
    expect(
      decodeComposerBridgeSnapshot({
        ...valid,
        deferred: [
          {
            operation: { type: "text.set", opId: "not-a-send", text: "x" },
            draft: valid.draft,
          },
        ],
      }),
    ).toEqual({ ok: false, message: "snapshot deferred send is invalid" });

    const storedAttachment = {
      id: "stored",
      url: `/api/media/${"a".repeat(64)}.png`,
      kind: "stored",
      status: "ready",
    };
    expect(
      decodeComposerBridgeSnapshot({
        ...valid,
        draft: { ...valid.draft, attachments: [storedAttachment] },
      }),
    ).toEqual({ ok: false, message: "snapshot draft is invalid" });
  });

  it("accepts empty reply previews and mention labels like the live decoder", () => {
    const client = createComposerBridgeClient();
    client.dispatchRaw({
      type: "reply.set",
      opId: "reply",
      reply: { messageId: "message", preview: "" },
    });
    client.dispatchRaw({
      type: "mention.add",
      opId: "mention",
      mention: { id: "user", label: "" },
    });

    expect(decodeComposerBridgeSnapshot(client.serialize())).toEqual({
      ok: true,
      snapshot: client.serialize(),
    });
  });

  it("rejects valid-shaped snapshots that exceed reducer limits", () => {
    const base = createComposerBridgeClient().serialize();
    const stored = {
      id: "attachment",
      url: `/api/media/${"a".repeat(64)}.png`,
      kind: "stored" as const,
      status: "ready" as const,
    };
    const limits = {
      ...DEFAULT_COMPOSER_LIMITS,
      maxTextLength: 4,
      maxAttachments: 1,
      maxAttachmentBytes: 2,
      maxIdLength: 4,
      maxMetadataLength: 4,
      maxMentions: 1,
      maxProcessedOpIds: 1,
    };
    const invalidSnapshots = [
      { ...base, draft: { ...base.draft, text: "12345" } },
      {
        ...base,
        draft: { ...base.draft, attachments: [stored, { ...stored, id: "b" }] },
      },
      { ...base, processedOpIds: ["one", "two"] },
      {
        ...base,
        deferred: [
          { operation: { type: "send", opId: "one" }, draft: base.draft },
          { operation: { type: "send", opId: "two" }, draft: base.draft },
        ],
      },
      { ...base, processedOpIds: ["12345"] },
      {
        ...base,
        draft: {
          ...base.draft,
          reply: { messageId: "one", preview: "12345" },
        },
      },
      {
        ...base,
        draft: {
          ...base.draft,
          mentions: [
            { id: "one", label: "" },
            { id: "two", label: "" },
          ],
        },
      },
      {
        ...base,
        draft: {
          ...base.draft,
          attachments: [
            {
              id: "one",
              url: "data:text/plain;base64,QUJD",
              mimeType: "text/plain",
              kind: "inline",
              status: "ready",
            },
          ],
        },
      },
    ];

    for (const snapshot of invalidSnapshots) {
      expect(decodeComposerBridgeSnapshot(snapshot, limits).ok).toBe(false);
    }
  });

  it("preserves idempotency across a serialize/hydrate reload", () => {
    const before = createComposerBridgeClient();
    before.dispatchRaw({ type: "text.insert", opId: "dup", text: "x" });
    const snapshot = before.serialize();
    expect(snapshot.schema).toBe(NATIVE_COMPOSER_SCHEMA);

    // Simulate a window reload: new client hydrated from the snapshot.
    const after = createComposerBridgeClient({ snapshot });
    expect(after.getDraft().text).toBe("x");
    const replay = after.dispatchRaw({
      type: "text.insert",
      opId: "dup",
      text: "x",
    });
    expect(replay.status).toBe("duplicate");
    expect(after.getDraft().text).toBe("x"); // not doubled
  });

  it("preserves a deferred offline send across reload, then replays on reconnect", () => {
    const before = createComposerBridgeClient({ online: false });
    before.dispatchRaw({ type: "text.set", opId: "t", text: "hi" });
    before.dispatchRaw({ type: "send", opId: "s" });
    const snapshot = before.serialize();
    expect(snapshot.deferred).toHaveLength(1);

    const after = createComposerBridgeClient({ online: false, snapshot });
    after.setOnline(true);
    expect(after.getState().sending?.opId).toBe("s");
    expect(after.getState().deferred).toHaveLength(0);
  });

  it("snapshots an in-flight send as replayable instead of falsely processed", () => {
    const before = createComposerBridgeClient();
    before.dispatchRaw({ type: "text.set", opId: "text", text: "hello" });
    before.dispatchRaw({ type: "send", opId: "send" });

    const snapshot = before.serialize();
    expect(snapshot.processedOpIds).not.toContain("send");
    expect(snapshot.deferred).toEqual([
      {
        operation: { type: "send", opId: "send" },
        draft: expect.objectContaining({ text: "hello" }),
      },
    ]);

    const after = createComposerBridgeClient({ online: false, snapshot });
    after.setOnline(true);
    expect(after.getState().sending?.opId).toBe("send");
  });
});

describe("createComposerBridgeClient — batch replay", () => {
  it("applies a stream envelope in order and surfaces malformed ops in place", () => {
    const client = createComposerBridgeClient();
    const results = client.dispatchRawStream({
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: [
        { type: "text.insert", opId: "1", text: "a" },
        { type: "text.insert", opId: "bad", text: 5 },
        { type: "text.insert", opId: "2", text: "b" },
      ],
    });
    expect(results.map((r) => r.status)).toEqual([
      "applied",
      "rejected",
      "applied",
    ]);
    expect(client.getDraft().text).toBe("ab");
  });

  it("de-dupes a replayed batch after reconnect", () => {
    const client = createComposerBridgeClient();
    const batch = {
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: [{ type: "text.insert", opId: "1", text: "a" }],
    };
    client.dispatchRawStream(batch);
    const second = client.dispatchRawStream(batch);
    expect(second[0].status).toBe("duplicate");
    expect(client.getDraft().text).toBe("a");
  });
});
