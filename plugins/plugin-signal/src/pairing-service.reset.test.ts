/**
 * Verifies that destructive teardown drains real pairing-session work before auth removal.
 * The native bridge is deterministic and writes only inside an isolated temporary directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SignalPairingEvent, SignalPairingSession } from "./pairing-service";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,signal-qr"),
  },
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
  vi.restoreAllMocks();
});

describe("Signal pairing reset quiescence", () => {
  it("waits for an in-flight native credential write and emits no connected event after stop", async () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-signal-reset-"));
    temporaryDirectories.add(authDir);
    const finishEntered = deferred();
    const allowFinish = deferred();
    const events: SignalPairingEvent[] = [];
    const getProfile = vi.fn(async () => ({ uuid: "linked-device", phoneNumber: "+15555550123" }));
    const native = {
      linkDevice: vi.fn(async () => "sgnl://linkdevice?uuid=test"),
      finishLink: vi.fn(async (directory: string) => {
        finishEntered.resolve();
        await allowFinish.promise;
        fs.writeFileSync(path.join(directory, "native-credentials"), "linked");
      }),
      getProfile,
    };
    const session = new SignalPairingSession({
      authDir,
      accountId: "default",
      onEvent: (event) => events.push(event),
    });
    (
      session as unknown as {
        loadSignalNativeModule: () => Promise<typeof native>;
      }
    ).loadSignalNativeModule = async () => native;

    const start = session.start();
    await finishEntered.promise;

    let stopSettled = false;
    const stop = session.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    allowFinish.resolve();
    await Promise.all([start, stop]);

    await expect(session.start()).rejects.toThrow("Signal pairing session has been stopped");
    expect(getProfile).not.toHaveBeenCalled();
    expect(events.some((event) => event.status === "connected")).toBe(false);
    expect(fs.existsSync(path.join(authDir, "native-credentials"))).toBe(true);

    fs.rmSync(authDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fs.existsSync(authDir)).toBe(false);
  });
});
