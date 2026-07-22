/**
 * Exercises the real filesystem-backed Electrobun composer host, including
 * adversarial custom-scheme input, restart recovery, atomic writes, and faults.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeNativeComposerOperation,
  configureNativeComposerHost,
  drainNativeComposerOperations,
  enqueueNativeComposerOperations,
  MAX_NATIVE_COMPOSER_QUEUE_LENGTH,
  MAX_NATIVE_COMPOSER_STATE_BYTES,
  NATIVE_COMPOSER_SCHEMA,
  NATIVE_COMPOSER_STATE_SCHEMA,
  NativeComposerHost,
  type NativeComposerOperationStream,
  nativeComposerOperationsFromDeepLink,
  publishNativeComposerEvent,
  readLatestNativeComposerEvent,
  resetNativeComposerHostForTests,
  sanitizeNativeComposerDeepLink,
} from "./native-composer-host";

let tempDir = "";

function captureElizaError(action: () => unknown): ElizaError {
  try {
    action();
  } catch (error) {
    if (error instanceof ElizaError) return error;
    throw error;
  }
  throw new Error("expected an ElizaError");
}

function deliveryIdFrom(stream: NativeComposerOperationStream): string {
  const delivery = stream.operations[0];
  if (
    !delivery ||
    typeof delivery !== "object" ||
    !("deliveryId" in delivery) ||
    typeof delivery.deliveryId !== "string"
  ) {
    throw new Error("operation stream did not contain a delivery id");
  }
  return delivery.deliveryId;
}

function acknowledgment(deliveryId: string) {
  return {
    schema: NATIVE_COMPOSER_SCHEMA,
    acknowledgment: {
      deliveryId,
      disposition: "persisted" as const,
      resultStatus: "applied",
    },
  };
}

function stateDirectory(userDataDir: string): string {
  return path.join(userDataDir, "native-composer");
}

function statePath(userDataDir: string): string {
  return path.join(stateDirectory(userDataDir), "state-v1.json");
}

function writeRawState(userDataDir: string, raw: string): void {
  fs.mkdirSync(stateDirectory(userDataDir), { recursive: true });
  fs.writeFileSync(statePath(userDataDir), raw, "utf8");
}

beforeEach(() => {
  resetNativeComposerHostForTests();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-native-composer-"));
  configureNativeComposerHost({ userDataDir: tempDir });
});

afterEach(() => {
  resetNativeComposerHostForTests();
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("text-only custom-scheme boundary", () => {
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
    expect(operations).not.toContainEqual(
      expect.objectContaining({ type: "attachment.add" }),
    );
  });

  it("removes absolute, encoded, traversal, nested URL, and forged-source file fields without reads", () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    const statSpy = vi.spyOn(fs, "statSync");
    const attacks = [
      "file=/etc/hosts",
      "FiLe=%2Fetc%2Fhosts",
      "%2566ile=%2Fetc%2Fhosts",
      "file=file%3A%2F%2F%2Fetc%2Fhosts",
      "redirect=file%253A%252F%252F%252Fetc%252Fhosts",
      "file=..%2F..%2Fetc%2Fhosts",
      "files=%5B%22%2Fetc%2Fhosts%22%5D",
      "file%5B0%5D=%2Fetc%2Fhosts",
      "file_path=%2Fetc%2Fhosts",
      "localPath=%2Fetc%2Fhosts",
      "attachment.source=file&attachment.path=%2Fetc%2Fhosts",
      "source=file&path=%2Fetc%2Fhosts",
      "payload=%7B%22source%22%3A%22file%22%2C%22path%22%3A%22%2Fetc%2Fhosts%22%7D",
      "url=file%3A%2F%2F%2Fetc%2Fhosts",
    ];

    for (const attack of attacks) {
      const url = `elizaos://share?text=safe&assistant.launchId=attack-1&${attack}`;
      expect(nativeComposerOperationsFromDeepLink(url)).toEqual([
        { type: "text.set", opId: "attack-1:text", text: "safe" },
        {
          type: "focus.set",
          opId: "attack-1:focus",
          focused: true,
          keyboard: "shown",
        },
      ]);
      const sanitized = new URL(sanitizeNativeComposerDeepLink(url));
      expect(sanitized.href).not.toContain("hosts");
      expect(
        [...sanitized.searchParams.entries()].some(([name, value]) => {
          const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
          return (
            normalizedName === "file" ||
            normalizedName === "files" ||
            normalizedName === "filepath" ||
            normalizedName === "path" ||
            normalizedName.startsWith("attachment") ||
            (name !== "text" && value.toLowerCase().startsWith("file:"))
          );
        }),
      ).toBe(false);
    }
    expect(readSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "never follows symlinks or opens FIFOs supplied through a deep link",
    () => {
      const symlinkPath = path.join(tempDir, "hosts-link");
      fs.symlinkSync("/etc/hosts", symlinkPath);
      const fifoPath = path.join(tempDir, "blocking.fifo");
      const fifo = spawnSync("mkfifo", [fifoPath]);
      expect(fifo.status).toBe(0);
      const readSpy = vi.spyOn(fs, "readFileSync");
      const openSpy = vi.spyOn(fs, "openSync");

      for (const filePath of [symlinkPath, fifoPath]) {
        const url = new URL("elizaos://share");
        url.searchParams.set("text", "review only");
        url.searchParams.set("assistant.launchId", "special-file");
        url.searchParams.set("file", filePath);
        expect(nativeComposerOperationsFromDeepLink(url.href)).toEqual([
          {
            type: "text.set",
            opId: "special-file:text",
            text: "review only",
          },
          {
            type: "focus.set",
            opId: "special-file:focus",
            focused: true,
            keyboard: "shown",
          },
        ]);
      }
      expect(readSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it("treats a file URL in text as inert draft text", () => {
    expect(
      nativeComposerOperationsFromDeepLink(
        "elizaos://chat?text=file%3A%2F%2F%2Fetc%2Fhosts&assistant.launchId=text-file",
      ),
    ).toEqual([
      {
        type: "text.set",
        opId: "text-file:text",
        text: "file:///etc/hosts",
      },
      {
        type: "focus.set",
        opId: "text-file:focus",
        focused: true,
        keyboard: "shown",
      },
    ]);
  });

  it("rejects a file URL as the launch itself without filesystem access", () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    const statSpy = vi.spyOn(fs, "statSync");
    expect(
      captureElizaError(() =>
        sanitizeNativeComposerDeepLink("file:///etc/hosts"),
      ).code,
    ).toBe("NATIVE_COMPOSER_DEEP_LINK_PROTOCOL_INVALID");
    expect(readSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
  });

  it("accepts only the configured custom scheme", () => {
    for (const url of [
      "content://chat?text=unsafe",
      "other-app://chat?text=unsafe",
      "https://example.com/chat?text=unsafe",
    ]) {
      expect(
        captureElizaError(() => sanitizeNativeComposerDeepLink(url)).code,
      ).toBe("NATIVE_COMPOSER_DEEP_LINK_PROTOCOL_INVALID");
    }
    expect(
      sanitizeNativeComposerDeepLink(
        "branded-app://chat?text=safe",
        "branded-app",
      ),
    ).toBe("branded-app://chat?text=safe");
    expect(
      captureElizaError(() =>
        sanitizeNativeComposerDeepLink("https://chat?text=unsafe", "https"),
      ).code,
    ).toBe("NATIVE_COMPOSER_DEEP_LINK_SCHEME_INVALID");
  });

  it("preserves non-file routing hints and ignores non-composer routes", () => {
    const sanitized = new URL(
      sanitizeNativeComposerDeepLink(
        "elizaos://assistant?text=hello&source=macos-shortcuts&action=lifeops.create&file=%2Fetc%2Fhosts",
      ),
    );
    expect(sanitized.searchParams.get("source")).toBe("macos-shortcuts");
    expect(sanitized.searchParams.get("action")).toBe("lifeops.create");
    expect(sanitized.searchParams.has("file")).toBe(false);
    expect(
      nativeComposerOperationsFromDeepLink(
        "elizaos://lifeops/task/new?text=buy%20milk&file=%2Fetc%2Fhosts",
      ),
    ).toEqual([]);
    expect(
      new URL(
        sanitizeNativeComposerDeepLink(
          "elizaos://lifeops/task/new?text=buy%20milk&file=%2Fetc%2Fhosts",
        ),
      ).searchParams.has("file"),
    ).toBe(false);
  });
});

describe("durable native composer state", () => {
  it("redelivers operations with the same delivery id after a process restart", () => {
    const firstHost = new NativeComposerHost({
      userDataDir: path.join(tempDir, "restart-queue"),
    });
    const enqueued = firstHost.enqueue([
      { type: "text.set", opId: "one", text: "persist me" },
    ]);
    const deliveryId = deliveryIdFrom(enqueued);

    const restartedHost = new NativeComposerHost({
      userDataDir: path.join(tempDir, "restart-queue"),
    });
    expect(restartedHost.drain()).toEqual({
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: [
        {
          deliveryId,
          operation: {
            type: "text.set",
            opId: "one",
            text: "persist me",
          },
        },
      ],
    });
  });

  it("persists acknowledgment removal before returning success", () => {
    const enqueued = enqueueNativeComposerOperations([
      { type: "text.set", opId: "one" },
    ]);
    const deliveryId = deliveryIdFrom(enqueued);
    expect(drainNativeComposerOperations()).toEqual({
      schema: NATIVE_COMPOSER_SCHEMA,
      operations: enqueued.operations,
    });
    expect(
      acknowledgeNativeComposerOperation(acknowledgment(deliveryId)),
    ).toEqual({ removed: true });

    resetNativeComposerHostForTests();
    configureNativeComposerHost({ userDataDir: tempDir });
    expect(drainNativeComposerOperations().operations).toEqual([]);
  });

  it("persists the latest event before publication succeeds and reloads it", () => {
    const event = { type: "draft.changed", draft: { text: "hello" } };
    expect(
      publishNativeComposerEvent({
        schema: NATIVE_COMPOSER_SCHEMA,
        event,
      }),
    ).toEqual({ ok: true });

    resetNativeComposerHostForTests();
    configureNativeComposerHost({ userDataDir: tempDir });
    expect(readLatestNativeComposerEvent("draft.changed")).toEqual(event);
  });

  it("persists a byte-backed draft event above the old metadata-only size", () => {
    const host = new NativeComposerHost({
      userDataDir: path.join(tempDir, "attachment-event"),
    });
    const event = {
      type: "draft.changed",
      draft: {
        text: "",
        attachments: [
          {
            id: "image-1",
            url: `data:image/png;base64,${"a".repeat(300 * 1024)}`,
            mimeType: "image/png",
            name: "proof.png",
            kind: "inline",
            status: "ready",
          },
        ],
        reply: null,
        mentions: [],
        focused: true,
        keyboard: "shown",
        revision: 1,
      },
    };
    expect(host.publish({ schema: NATIVE_COMPOSER_SCHEMA, event })).toEqual({
      ok: true,
    });

    const restartedHost = new NativeComposerHost({
      userDataDir: path.join(tempDir, "attachment-event"),
    });
    expect(restartedHost.readLatestEvent("draft.changed")).toEqual(event);
  });

  it("writes a strict versioned envelope and leaves no temp file after commit", () => {
    const host = new NativeComposerHost({
      userDataDir: path.join(tempDir, "strict-envelope"),
    });
    const stream = host.enqueue([{ type: "focus.set", opId: "focus" }]);
    expect(JSON.parse(fs.readFileSync(host.statePath, "utf8"))).toEqual({
      schema: NATIVE_COMPOSER_STATE_SCHEMA,
      revision: 1,
      operationQueue: [
        {
          deliveryId: deliveryIdFrom(stream),
          operation: { type: "focus.set", opId: "focus" },
        },
      ],
      latestRendererEvents: [],
    });
    expect(
      fs
        .readdirSync(host.stateDirectory)
        .filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("removes only stale copy-on-write temp files during restart", () => {
    const userDataDir = path.join(tempDir, "stale-temp");
    fs.mkdirSync(stateDirectory(userDataDir), { recursive: true });
    const staleTempPath = path.join(
      stateDirectory(userDataDir),
      "state-v1.json.999.stale-id.tmp",
    );
    const unrelatedPath = path.join(stateDirectory(userDataDir), "owner-note");
    fs.writeFileSync(staleTempPath, "uncommitted", "utf8");
    fs.writeFileSync(unrelatedPath, "keep", "utf8");

    const restartedHost = new NativeComposerHost({ userDataDir });
    expect(restartedHost.drain().operations).toEqual([]);
    expect(fs.existsSync(staleTempPath)).toBe(false);
    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("keep");
  });

  it("orders temp write, file fsync, close, rename, and directory fsync", () => {
    const host = new NativeComposerHost({
      userDataDir: path.join(tempDir, "atomic-order"),
      platform: "darwin",
    });
    const openSpy = vi.spyOn(fs, "openSync");
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const closeSpy = vi.spyOn(fs, "closeSync");
    const renameSpy = vi.spyOn(fs, "renameSync");

    host.enqueue([{ type: "text.set", opId: "atomic" }]);

    const tempOpenIndex = openSpy.mock.calls.findIndex(([target]) =>
      String(target).endsWith(".tmp"),
    );
    const directoryOpenIndex = openSpy.mock.calls.findIndex(
      ([target]) => String(target) === host.stateDirectory,
    );
    expect(tempOpenIndex).toBeGreaterThanOrEqual(0);
    expect(directoryOpenIndex).toBeGreaterThan(tempOpenIndex);
    const tempOpenOrder = openSpy.mock.invocationCallOrder[tempOpenIndex];
    const firstFsyncOrder = fsyncSpy.mock.invocationCallOrder[0];
    const firstCloseOrder = closeSpy.mock.invocationCallOrder[0];
    const renameOrder = renameSpy.mock.invocationCallOrder[0];
    const directoryOpenOrder =
      openSpy.mock.invocationCallOrder[directoryOpenIndex];
    const directoryFsyncOrder = fsyncSpy.mock.invocationCallOrder[1];
    expect(tempOpenOrder).toBeLessThan(firstFsyncOrder);
    expect(firstFsyncOrder).toBeLessThan(firstCloseOrder);
    expect(firstCloseOrder).toBeLessThan(renameOrder);
    expect(renameOrder).toBeLessThan(directoryOpenOrder);
    expect(directoryOpenOrder).toBeLessThan(directoryFsyncOrder);
  });

  it("rejects unbounded queues and values without changing durable state", () => {
    const host = new NativeComposerHost({
      userDataDir: path.join(tempDir, "bounds"),
    });
    const queueError = captureElizaError(() =>
      host.enqueue(
        Array.from(
          { length: MAX_NATIVE_COMPOSER_QUEUE_LENGTH + 1 },
          (_, index) => ({
            type: "text.set",
            opId: `operation-${index}`,
          }),
        ),
      ),
    );
    expect(queueError.code).toBe("NATIVE_COMPOSER_QUEUE_LIMIT");
    const valueError = captureElizaError(() =>
      host.enqueue([
        {
          type: "text.set",
          text: "x".repeat(256 * 1024),
        },
      ]),
    );
    expect(valueError.code).toBe("NATIVE_COMPOSER_STATE_TOO_LARGE");
    expect(host.drain().operations).toEqual([]);
    expect(fs.existsSync(host.statePath)).toBe(false);
  });
});

describe("durability failures", () => {
  it("does not acknowledge removal when atomic rename fails", () => {
    const userDataDir = path.join(tempDir, "failed-ack");
    const host = new NativeComposerHost({ userDataDir });
    const deliveryId = deliveryIdFrom(
      host.enqueue([{ type: "text.set", opId: "retry" }]),
    );
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected rename failure");
    });

    const error = captureElizaError(() =>
      host.acknowledge(acknowledgment(deliveryId)),
    );
    expect(error.code).toBe("NATIVE_COMPOSER_STATE_WRITE_FAILED");
    expect(error.context).toMatchObject({ renamed: false });
    expect(captureElizaError(() => host.drain()).code).toBe(
      "NATIVE_COMPOSER_STATE_WRITE_FAILED",
    );
    renameSpy.mockRestore();

    const restartedHost = new NativeComposerHost({ userDataDir });
    expect(deliveryIdFrom(restartedHost.drain())).toBe(deliveryId);
    expect(
      fs
        .readdirSync(restartedHost.stateDirectory)
        .filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("does not publish an event when the temp file fsync fails", () => {
    const userDataDir = path.join(tempDir, "failed-event");
    const host = new NativeComposerHost({ userDataDir });
    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("injected fsync failure");
    });
    const error = captureElizaError(() =>
      host.publish({
        schema: NATIVE_COMPOSER_SCHEMA,
        event: { type: "draft.changed", draft: { text: "not durable" } },
      }),
    );
    expect(error.code).toBe("NATIVE_COMPOSER_STATE_WRITE_FAILED");
    expect(error.context).toMatchObject({ renamed: false });
    fsyncSpy.mockRestore();

    const restartedHost = new NativeComposerHost({ userDataDir });
    expect(restartedHost.readLatestEvent("draft.changed")).toBeUndefined();
  });

  it("reports failure when directory fsync fails after rename and reloads the on-disk result", () => {
    const userDataDir = path.join(tempDir, "failed-directory-fsync");
    const host = new NativeComposerHost({ userDataDir, platform: "darwin" });
    const realFsync = fs.fsyncSync;
    let fsyncCalls = 0;
    const fsyncSpy = vi
      .spyOn(fs, "fsyncSync")
      .mockImplementation((descriptor) => {
        fsyncCalls += 1;
        if (fsyncCalls === 2)
          throw new Error("injected directory fsync failure");
        return realFsync(descriptor);
      });
    const error = captureElizaError(() =>
      host.enqueue([{ type: "text.set", opId: "renamed" }]),
    );
    expect(error.code).toBe("NATIVE_COMPOSER_STATE_WRITE_FAILED");
    expect(error.context).toMatchObject({ renamed: true });
    fsyncSpy.mockRestore();

    const restartedHost = new NativeComposerHost({
      userDataDir,
      platform: "darwin",
    });
    expect(restartedHost.drain().operations).toHaveLength(1);
  });
});

describe("corrupt-state handling", () => {
  it("quarantines malformed JSON and fails startup explicitly", () => {
    const userDataDir = path.join(tempDir, "corrupt-json");
    writeRawState(userDataDir, "{not-json");
    const error = captureElizaError(
      () =>
        new NativeComposerHost({
          userDataDir,
          now: () => 1234,
          randomId: () => "quarantine-id",
        }),
    );
    expect(error.code).toBe("NATIVE_COMPOSER_STATE_CORRUPT");
    expect(fs.existsSync(statePath(userDataDir))).toBe(false);
    const quarantinePath = path.join(
      stateDirectory(userDataDir),
      "state-v1.corrupt.1234.quarantine-id.json",
    );
    expect(fs.readFileSync(quarantinePath, "utf8")).toBe("{not-json");
  });

  it("quarantines wrong versions, extra fields, duplicates, and oversized state", () => {
    const invalidStates: Array<{ name: string; raw: string }> = [
      {
        name: "wrong-version",
        raw: JSON.stringify({
          schema: "eliza.native-composer-host-state/v2",
          revision: 0,
          operationQueue: [],
          latestRendererEvents: [],
        }),
      },
      {
        name: "extra-field",
        raw: JSON.stringify({
          schema: NATIVE_COMPOSER_STATE_SCHEMA,
          revision: 0,
          operationQueue: [],
          latestRendererEvents: [],
          ignored: true,
        }),
      },
      {
        name: "duplicate-delivery",
        raw: JSON.stringify({
          schema: NATIVE_COMPOSER_STATE_SCHEMA,
          revision: 1,
          operationQueue: [
            { deliveryId: "same", operation: { type: "text.set" } },
            { deliveryId: "same", operation: { type: "focus.set" } },
          ],
          latestRendererEvents: [],
        }),
      },
    ];

    for (const invalidState of invalidStates) {
      const userDataDir = path.join(tempDir, invalidState.name);
      writeRawState(userDataDir, invalidState.raw);
      const error = captureElizaError(
        () => new NativeComposerHost({ userDataDir }),
      );
      expect(error.code, invalidState.name).toBe(
        "NATIVE_COMPOSER_STATE_CORRUPT",
      );
      expect(fs.existsSync(statePath(userDataDir)), invalidState.name).toBe(
        false,
      );
      expect(
        fs
          .readdirSync(stateDirectory(userDataDir))
          .filter((name) => name.includes(".corrupt.")),
        invalidState.name,
      ).toHaveLength(1);
    }

    const oversizedDataDir = path.join(tempDir, "oversized");
    writeRawState(oversizedDataDir, "x");
    fs.truncateSync(
      statePath(oversizedDataDir),
      MAX_NATIVE_COMPOSER_STATE_BYTES + 1,
    );
    expect(
      captureElizaError(
        () => new NativeComposerHost({ userDataDir: oversizedDataDir }),
      ).code,
    ).toBe("NATIVE_COMPOSER_STATE_CORRUPT");
    expect(fs.existsSync(statePath(oversizedDataDir))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "quarantines symlink and FIFO state paths without reading either target",
    () => {
      const readSpy = vi.spyOn(fs, "readFileSync");
      const symlinkDataDir = path.join(tempDir, "state-symlink");
      fs.mkdirSync(stateDirectory(symlinkDataDir), { recursive: true });
      fs.symlinkSync("/etc/hosts", statePath(symlinkDataDir));
      expect(
        captureElizaError(
          () => new NativeComposerHost({ userDataDir: symlinkDataDir }),
        ).code,
      ).toBe("NATIVE_COMPOSER_STATE_CORRUPT");

      const fifoDataDir = path.join(tempDir, "state-fifo");
      fs.mkdirSync(stateDirectory(fifoDataDir), { recursive: true });
      expect(spawnSync("mkfifo", [statePath(fifoDataDir)]).status).toBe(0);
      expect(
        captureElizaError(
          () => new NativeComposerHost({ userDataDir: fifoDataDir }),
        ).code,
      ).toBe("NATIVE_COMPOSER_STATE_CORRUPT");
      expect(readSpy).not.toHaveBeenCalled();
    },
  );

  it("surfaces quarantine failure without pretending recovery succeeded", () => {
    const userDataDir = path.join(tempDir, "quarantine-failure");
    writeRawState(userDataDir, "{invalid");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected quarantine rename failure");
    });
    const error = captureElizaError(
      () => new NativeComposerHost({ userDataDir }),
    );
    expect(error.code).toBe("NATIVE_COMPOSER_STATE_QUARANTINE_FAILED");
    expect(error.context).toMatchObject({ renamed: false });
    expect(fs.existsSync(statePath(userDataDir))).toBe(true);
    renameSpy.mockRestore();
  });

  it("clears the process host when reconfiguration fails", () => {
    const userDataDir = path.join(tempDir, "failed-reconfigure");
    writeRawState(userDataDir, "{invalid");
    expect(
      captureElizaError(() => configureNativeComposerHost({ userDataDir }))
        .code,
    ).toBe("NATIVE_COMPOSER_STATE_CORRUPT");
    expect(captureElizaError(() => drainNativeComposerOperations()).code).toBe(
      "NATIVE_COMPOSER_HOST_NOT_CONFIGURED",
    );
  });

  it("wraps an unusable userData directory as an explicit fatal error", () => {
    const userDataFile = path.join(tempDir, "not-a-directory");
    fs.writeFileSync(userDataFile, "occupied", "utf8");
    const error = captureElizaError(
      () => new NativeComposerHost({ userDataDir: userDataFile }),
    );
    expect(error.code).toBe("NATIVE_COMPOSER_STATE_DIRECTORY_FAILED");
    expect(error.cause).toBeInstanceOf(Error);
  });
});
