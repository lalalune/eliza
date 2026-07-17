/**
 * Verifies that destructive teardown drains Baileys startup and credential writes.
 * All filesystem effects are confined to isolated temporary directories.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppPairingSession } from "./pairing-service";

const baileysMocks = vi.hoisted(() => ({
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(),
}));

vi.mock("@whiskeysockets/baileys", () => ({
  default: baileysMocks.makeWASocket,
  useMultiFileAuthState: baileysMocks.useMultiFileAuthState,
  fetchLatestBaileysVersion: baileysMocks.fetchLatestBaileysVersion,
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 410,
    timedOut: 408,
    connectionClosed: 428,
    connectionReplaced: 440,
  },
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,whatsapp-qr") },
}));
vi.mock("pino", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@hapi/boom", () => ({ Boom: class Boom {} }));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeBaileysEvents {
  private readonly listeners = new Map<string, Set<(value: unknown) => unknown>>();

  on(event: string, listener: (value: unknown) => unknown): void {
    const eventListeners = this.listeners.get(event) ?? new Set();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
  }

  removeAllListeners(event: string): void {
    this.listeners.delete(event);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const temporaryDirectories = new Set<string>();

beforeEach(() => {
  baileysMocks.makeWASocket.mockReset();
  baileysMocks.useMultiFileAuthState.mockReset();
  baileysMocks.fetchLatestBaileysVersion.mockReset();
  baileysMocks.fetchLatestBaileysVersion.mockResolvedValue({ version: [2, 3000, 0] });
});

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
  vi.restoreAllMocks();
});

function createAuthDir(): string {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-whatsapp-reset-"));
  temporaryDirectories.add(authDir);
  return authDir;
}

describe("WhatsApp pairing reset quiescence", () => {
  it("waits for in-flight auth-state startup before returning from stop", async () => {
    const authDir = createAuthDir();
    const startupEntered = deferred();
    const allowStartup = deferred();
    baileysMocks.useMultiFileAuthState.mockImplementation(async (directory: string) => {
      startupEntered.resolve();
      await allowStartup.promise;
      fs.writeFileSync(path.join(directory, "creds.json"), "startup-write");
      return { state: {}, saveCreds: vi.fn(async () => undefined) };
    });
    const session = new WhatsAppPairingSession({
      authDir,
      accountId: "default",
      onEvent: vi.fn(),
    });

    const start = session.start();
    await startupEntered.promise;
    let stopSettled = false;
    const stop = session.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    allowStartup.resolve();
    await Promise.all([start, stop]);
    await expect(session.start()).rejects.toThrow("WhatsApp pairing session has been stopped");
    expect(baileysMocks.makeWASocket).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(authDir, "creds.json"))).toBe(true);

    fs.rmSync(authDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fs.existsSync(authDir)).toBe(false);
  });

  it("waits for an in-flight credential write and detaches late write callbacks", async () => {
    const authDir = createAuthDir();
    const writeEntered = deferred();
    const allowWrite = deferred();
    const saveCreds = vi.fn(async () => {
      writeEntered.resolve();
      await allowWrite.promise;
      fs.writeFileSync(path.join(authDir, "creds.json"), "credential-write");
    });
    const events = new FakeBaileysEvents();
    const socket = {
      ev: events,
      end: vi.fn(),
      user: null,
    };
    baileysMocks.useMultiFileAuthState.mockResolvedValue({ state: {}, saveCreds });
    baileysMocks.makeWASocket.mockReturnValue(socket);
    const session = new WhatsAppPairingSession({
      authDir,
      accountId: "default",
      onEvent: vi.fn(),
    });

    await session.start();
    expect(events.listenerCount("creds.update")).toBe(1);
    events.emit("creds.update", {});
    await writeEntered.promise;

    let stopSettled = false;
    const stop = session.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    allowWrite.resolve();
    await stop;
    expect(socket.end).toHaveBeenCalledOnce();
    expect(events.listenerCount("creds.update")).toBe(0);

    fs.rmSync(authDir, { recursive: true, force: true });
    events.emit("creds.update", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(saveCreds).toHaveBeenCalledOnce();
    expect(fs.existsSync(authDir)).toBe(false);
  });

  it("still drains credential writes when socket teardown throws", async () => {
    const authDir = createAuthDir();
    const writeEntered = deferred();
    const allowWrite = deferred();
    const saveCreds = vi.fn(async () => {
      writeEntered.resolve();
      await allowWrite.promise;
      fs.writeFileSync(path.join(authDir, "creds.json"), "credential-write");
    });
    const events = new FakeBaileysEvents();
    const socket = {
      ev: events,
      end: vi.fn(() => {
        throw new Error("socket close failed");
      }),
      user: null,
    };
    baileysMocks.useMultiFileAuthState.mockResolvedValue({ state: {}, saveCreds });
    baileysMocks.makeWASocket.mockReturnValue(socket);
    const session = new WhatsAppPairingSession({
      authDir,
      accountId: "default",
      onEvent: vi.fn(),
    });

    await session.start();
    events.emit("creds.update", {});
    await writeEntered.promise;

    let stopSettled = false;
    const stop = session.stop();
    void stop.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      }
    );
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    allowWrite.resolve();
    await expect(stop).rejects.toThrow("Failed to stop WhatsApp pairing cleanly");
    expect(fs.readFileSync(path.join(authDir, "creds.json"), "utf8")).toBe("credential-write");
  });
});
