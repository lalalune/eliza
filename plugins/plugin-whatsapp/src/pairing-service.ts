/**
 * WhatsApp pairing service — manages Baileys sessions for QR code authentication.
 *
 * This service is separate from the main WhatsApp plugin because the plugin
 * initializes during runtime startup (too late for interactive QR flow).
 * Once pairing succeeds, the auth state is persisted to disk so the plugin
 * can reconnect automatically on subsequent startups.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";

const LOG_PREFIX = "[whatsapp-pairing]";

/** Validate accountId to prevent path traversal. Only allows alphanumeric, dash, underscore. */
export function sanitizeAccountId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned || cleaned !== raw) {
    throw new Error(
      `Invalid accountId: must only contain alphanumeric characters, dashes, and underscores`
    );
  }
  return cleaned;
}

export type WhatsAppPairingStatus =
  | "idle"
  | "initializing"
  | "waiting_for_qr"
  | "connected"
  | "disconnected"
  | "timeout"
  | "error";

export interface WhatsAppPairingEvent {
  type: "whatsapp-qr" | "whatsapp-status";
  accountId: string;
  qrDataUrl?: string;
  expiresInMs?: number;
  status?: WhatsAppPairingStatus;
  phoneNumber?: string;
  error?: string;
}

export interface WhatsAppPairingOptions {
  authDir: string;
  accountId: string;
  onEvent: (event: WhatsAppPairingEvent) => void;
}

export class WhatsAppPairingSession {
  private socket: ReturnType<typeof import("@whiskeysockets/baileys").default> | null = null;
  private status: WhatsAppPairingStatus = "idle";
  private options: WhatsAppPairingOptions;
  private qrAttempts = 0;
  private readonly MAX_QR_ATTEMPTS = 5;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private generation = 0;
  private activeStart: Promise<void> | null = null;
  private acceptingStarts = true;
  private readonly pendingCredentialWrites = new Set<Promise<void>>();
  private readonly credentialWriteErrors: unknown[] = [];

  constructor(options: WhatsAppPairingOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (!this.acceptingStarts) {
      throw new Error("WhatsApp pairing session has been stopped");
    }
    if (this.activeStart) {
      await this.activeStart;
      return;
    }
    const run = this.startInternal();
    this.activeStart = run;
    try {
      await run;
    } finally {
      if (this.activeStart === run) this.activeStart = null;
    }
  }

  private async startInternal(): Promise<void> {
    this.stopped = false;
    const generation = ++this.generation;
    this.setStatus("initializing");

    const baileys = await import("@whiskeysockets/baileys");
    if (!this.isActive(generation)) return;
    const makeWASocket = baileys.default;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;
    const QRCode = (await import("qrcode")).default;
    const { Boom } = await import("@hapi/boom");
    if (!this.isActive(generation)) return;

    fs.mkdirSync(this.options.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);
    if (!this.isActive(generation)) return;
    const { version } = await fetchLatestBaileysVersion();
    if (!this.isActive(generation)) return;

    const pino = (await import("pino")).default;
    if (!this.isActive(generation)) return;
    const baileysLogger = pino({ level: "silent" });

    this.socket = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ["Eliza AI", "Desktop", "1.0.0"],
    });

    this.socket.ev.on("creds.update", () => {
      if (!this.isActive(generation)) return;
      const write = Promise.resolve().then(() => saveCreds());
      this.pendingCredentialWrites.add(write);
      void write.then(
        () => this.pendingCredentialWrites.delete(write),
        (error) => {
          this.pendingCredentialWrites.delete(write);
          this.credentialWriteErrors.push(error);
        }
      );
    });

    this.socket.ev.on("connection.update", async (update) => {
      if (!this.isActive(generation)) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrAttempts++;
        logger.info(
          `${LOG_PREFIX} QR code received (attempt ${this.qrAttempts}/${this.MAX_QR_ATTEMPTS})`
        );
        if (this.qrAttempts > this.MAX_QR_ATTEMPTS) {
          this.setStatus("timeout");
          try {
            await this.stop();
          } catch (error) {
            // error-policy:J1 Async event listeners translate teardown failure into an observable pairing error.
            const message = error instanceof Error ? error.message : String(error);
            logger.error({ error }, `${LOG_PREFIX} Failed to stop timed-out pairing session`);
            this.setStatus("error");
            this.options.onEvent({
              type: "whatsapp-status",
              accountId: this.options.accountId,
              status: "error",
              error: message,
            });
          }
          return;
        }

        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
          });
          if (!this.isActive(generation)) return;

          this.setStatus("waiting_for_qr");
          this.options.onEvent({
            type: "whatsapp-qr",
            accountId: this.options.accountId,
            qrDataUrl,
            expiresInMs: 20_000,
          });
        } catch (error) {
          // error-policy:J4 A later Baileys QR replaces this transient rendering failure for the user.
          logger.warn({ error }, `${LOG_PREFIX} Failed to render QR; waiting for the next attempt`);
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
        logger.info(
          `${LOG_PREFIX} Connection closed, statusCode=${statusCode}, status=${this.status}`
        );
        if (statusCode === DisconnectReason.loggedOut) {
          this.setStatus("disconnected");
        } else if (
          statusCode === DisconnectReason.restartRequired ||
          statusCode === DisconnectReason.timedOut ||
          statusCode === DisconnectReason.connectionClosed ||
          statusCode === DisconnectReason.connectionReplaced
        ) {
          logger.info(`${LOG_PREFIX} Restarting pairing after transient close...`);
          this.socket = null;
          this.qrAttempts = 0;
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.isActive(generation)) return;
            this.start().catch((err) => {
              if (this.stopped) return;
              logger.error({ error: err }, `${LOG_PREFIX} Restart failed`);
              this.setStatus("error");
              this.options.onEvent({
                type: "whatsapp-status",
                accountId: this.options.accountId,
                status: "error",
                error: String(err),
              });
            });
          }, 3000);
        }
      } else if (connection === "open") {
        const phoneNumber = this.socket?.user?.id?.split(":")[0] ?? "";
        this.setStatus("connected");
        this.options.onEvent({
          type: "whatsapp-status",
          accountId: this.options.accountId,
          status: "connected",
          phoneNumber,
        });
      }
    });
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    this.acceptingStarts = false;
    this.stopped = true;
    this.generation += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const socket = this.socket;
    socket?.ev.removeAllListeners("creds.update");
    socket?.ev.removeAllListeners("connection.update");
    try {
      socket?.end(undefined);
    } catch (error) {
      // error-policy:J6 Reset still drains in-flight startup and credential writes after socket teardown fails.
      errors.push(new Error("Failed to stop WhatsApp pairing socket", { cause: error }));
    }
    this.socket = null;
    if (this.activeStart) {
      try {
        await this.activeStart;
      } catch (error) {
        // error-policy:J6 Surface startup teardown failures only after all pairing work has quiesced.
        errors.push(error);
      }
    }
    const writes = [...this.pendingCredentialWrites];
    if (writes.length > 0) {
      await Promise.allSettled(writes);
    }
    errors.push(...this.credentialWriteErrors.splice(0));
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to stop WhatsApp pairing cleanly");
    }
  }

  getStatus(): WhatsAppPairingStatus {
    return this.status;
  }

  private setStatus(status: WhatsAppPairingStatus): void {
    this.status = status;
    this.options.onEvent({
      type: "whatsapp-status",
      accountId: this.options.accountId,
      status,
    });
  }

  private isActive(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }
}

export function whatsappAuthExists(workspaceDir: string, accountId = "default"): boolean {
  const credsPath = path.join(workspaceDir, "whatsapp-auth", accountId, "creds.json");
  return fs.existsSync(credsPath);
}

export async function whatsappLogout(workspaceDir: string, accountId = "default"): Promise<void> {
  const authDir = path.join(workspaceDir, "whatsapp-auth", accountId);
  const credsPath = path.join(authDir, "creds.json");

  if (fs.existsSync(credsPath)) {
    try {
      const baileys = await import("@whiskeysockets/baileys");
      const makeWASocket = baileys.default;
      const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
      const pino = (await import("pino")).default;
      const logger = pino({ level: "silent" });

      const { state } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
      });

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try {
            sock.ev.removeAllListeners("connection.update");
          } catch (error) {
            // error-policy:J6 Listener cleanup is best effort after logout has already reached its boundary.
            logger.warn({ error }, `${LOG_PREFIX} Failed to remove logout listeners`);
          }
          try {
            sock.end(undefined);
          } catch (error) {
            // error-policy:J6 Local auth deletion remains authoritative even when socket teardown fails.
            logger.warn({ error }, `${LOG_PREFIX} Failed to close logout socket`);
          }
          resolve();
        };

        const timeout = setTimeout(finish, 10_000);

        sock.ev.on("connection.update", async (update) => {
          if (update.connection === "open") {
            try {
              await sock.logout();
            } catch (error) {
              // error-policy:J6 Remote logout may already have completed; local auth removal still proceeds.
              logger.warn({ error }, `${LOG_PREFIX} Remote logout did not complete cleanly`);
            }
            finish();
          } else if (update.connection === "close") {
            finish();
          }
        });
      });
    } catch (error) {
      // error-policy:J6 Local auth deletion is the teardown invariant when Baileys cannot reconnect.
      logger.warn({ error }, `${LOG_PREFIX} Could not reconnect for remote logout`);
    }
  }

  fs.rmSync(authDir, { recursive: true, force: true });
}
