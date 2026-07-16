/**
 * End-to-end proof for the iMessage collector using a real SQLite database,
 * real attachment bytes, the production Bun CLI, and deterministic reruns.
 * The fixture contains no owner data and exercises cutoff, join fanout,
 * exclusions, attachment hashing, manifests, and fail-fast missing bytes.
 */
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CORPUS_CUTOFF_MS } from "../schema.ts";
import { buildCorpusManifest, validateCorpusTarget } from "../validator.ts";
import { verifyIMessageCollectionReceipt } from "./imessage.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const appleEpochMs = Date.UTC(2001, 0, 1);

function appleNs(timestamp: number): bigint {
  return BigInt(timestamp - appleEpochMs) * 1_000_000n;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createChatDb(
  dbPath: string,
  attachmentPath: string,
  attachmentBytes = 5,
): Promise<void> {
  await execFileAsync("/usr/bin/sqlite3", [
    dbPath,
    `
    PRAGMA journal_mode=WAL;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      chat_identifier TEXT,
      display_name TEXT,
      service_name TEXT,
      style INTEGER,
      last_read_message_timestamp INTEGER
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      date INTEGER,
      date_read INTEGER,
      date_edited INTEGER,
      date_retracted INTEGER,
      is_from_me INTEGER,
      is_read INTEGER,
      is_sent INTEGER,
      is_delivered INTEGER,
      item_type INTEGER,
      reply_to_guid TEXT,
      associated_message_guid TEXT,
      associated_message_type INTEGER,
      associated_message_emoji TEXT,
      cache_has_attachments INTEGER,
      service TEXT,
      handle_id INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      transfer_name TEXT,
      filename TEXT,
      mime_type TEXT,
      uti TEXT,
      total_bytes INTEGER,
      is_sticker INTEGER
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550000001', 'iMessage');
    INSERT INTO handle VALUES (2, '+15550000002', 'iMessage');
    INSERT INTO chat VALUES (1, 'fixture-direct', NULL, 'iMessage', 45, 0);
    INSERT INTO chat VALUES (2, 'fixture-group', 'Fixture Group', 'iMessage', 43, 0);
    INSERT INTO chat_handle_join VALUES (1, 1);
    INSERT INTO chat_handle_join VALUES (2, 1);
    INSERT INTO chat_handle_join VALUES (2, 2);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (1, 'before-cutoff', 'old', ${appleNs(CORPUS_CUTOFF_MS - 1)}, 0, 0, 0, 'iMessage', 1);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (2, 'incoming-1', 'hello', ${appleNs(Date.UTC(2024, 6, 5))}, 0, 0, 0, 'iMessage', 1);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, reply_to_guid, cache_has_attachments, service, handle_id)
      VALUES (3, 'outgoing-1', 'reply', ${appleNs(Date.UTC(2024, 7, 1))}, 1, 0, 'incoming-1', 0, 'iMessage', 1);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, associated_message_guid, associated_message_type, cache_has_attachments, service, handle_id)
      VALUES (4, 'reaction-1', NULL, ${appleNs(Date.UTC(2024, 7, 2))}, 0, 0, 'incoming-1', 2001, 0, 'iMessage', 2);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (5, 'system-1', NULL, ${appleNs(Date.UTC(2024, 7, 3))}, 0, 1, 0, 'iMessage', 2);
    INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, cache_has_attachments, service, handle_id)
      VALUES (6, 'attachment-only', '', ${appleNs(Date.UTC(2024, 8, 1))}, 0, 0, 1, 'iMessage', 2);
    INSERT INTO chat_message_join VALUES (1, 1);
    INSERT INTO chat_message_join VALUES (1, 2);
    INSERT INTO chat_message_join VALUES (2, 2);
    INSERT INTO chat_message_join VALUES (1, 3);
    INSERT INTO chat_message_join VALUES (2, 4);
    INSERT INTO chat_message_join VALUES (2, 5);
    INSERT INTO chat_message_join VALUES (2, 6);
    INSERT INTO attachment VALUES (1, 'attachment-1', 'fixture.bin', ${sqlString(attachmentPath)}, 'application/octet-stream', 'public.data', ${attachmentBytes}, 0);
    INSERT INTO message_attachment_join VALUES (6, 1);
  `,
  ]);
}

async function attachFixtureToMessage(
  dbPath: string,
  messageRowId: number,
): Promise<void> {
  await execFileAsync("/usr/bin/sqlite3", [
    dbPath,
    `INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (${messageRowId}, 1);`,
  ]);
}

async function runCollector(
  root: string,
  outputName: string,
  policy?: "fail" | "record-omission",
  accountId = "local",
): Promise<{
  stdout: string;
  output: string;
  state: string;
}> {
  const output = path.join(root, outputName);
  const state = path.join(output, ".state");
  const result = await execFileAsync(
    "bun",
    collectorArgs(root, output, policy, accountId),
    {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return { stdout: result.stdout, output, state };
}

function collectorArgs(
  root: string,
  output: string,
  policy?: "fail" | "record-omission",
  accountId = "local",
): string[] {
  const args = [
    "--conditions=eliza-source",
    path.resolve(import.meta.dirname, "../cli.ts"),
    "collect",
    "imessage",
    "--output",
    output,
    "--account-id",
    accountId,
    "--owner-id",
    "owner",
    "--owner-display",
    "Owner",
    "--db",
    path.join(root, "chat.db"),
    "--attachment-root",
    path.join(root, "Attachments"),
    "--page-size",
    "1",
  ];
  if (policy) args.push("--unavailable-attachment-policy", policy);
  return args;
}

async function crashCollectorAtPhase(
  root: string,
  output: string,
  targetPhase: string,
): Promise<void> {
  const preloadPath = path.join(root, `stop-after-${targetPhase}.mjs`);
  await fs.writeFile(
    preloadPath,
    `
      import { promises as fs } from "node:fs";
      const rename = fs.rename.bind(fs);
      fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (String(destination).endsWith("/.corpus-transaction.json")) {
          const journal = JSON.parse(await fs.readFile(destination, "utf8"));
          if (journal.phase === ${JSON.stringify(targetPhase)}) {
            process.stderr.write("crash-phase:${targetPhase}\\n");
            process.kill(process.pid, "SIGSTOP");
          }
        }
      };
    `,
    { mode: 0o600 },
  );
  const child = spawn(
    "bun",
    [
      "--preload",
      preloadPath,
      ...collectorArgs(root, output, "record-omission"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes(`crash-phase:${targetPhase}\n`)) resolve();
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Collector exited before ${targetPhase}: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    });
  });
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function crashCollectorAfterBackupQuarantine(
  root: string,
  output: string,
): Promise<void> {
  const preloadPath = path.join(root, "stop-after-backup-quarantine.mjs");
  await fs.writeFile(
    preloadPath,
    `
      import { promises as fs } from "node:fs";
      const rename = fs.rename.bind(fs);
      fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (String(source).endsWith(".backup") && String(destination).endsWith(".removing")) {
          process.stderr.write("crash-backup-quarantine\\n");
          process.kill(process.pid, "SIGSTOP");
        }
      };
    `,
    { mode: 0o600 },
  );
  const child = spawn(
    "bun",
    [
      "--preload",
      preloadPath,
      ...collectorArgs(root, output, "record-omission"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("crash-backup-quarantine\n")) resolve();
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Collector exited before backup quarantine: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    });
  });
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function crashCollectorAfterAllocation(
  root: string,
  output: string,
  point: "root" | "snapshot" | "stage",
): Promise<void> {
  const preloadPath = path.join(root, `stop-after-${point}-allocation.mjs`);
  const matches =
    point === "root"
      ? 'value.endsWith(".eliza-imessage-preparing")'
      : point === "snapshot"
        ? 'value.includes("/.state/.imessage-snapshot.") && value.endsWith(".allocating")'
        : 'value.includes("/imessage/.local.") && value.endsWith(".stage")';
  await fs.writeFile(
    preloadPath,
    `
      import { promises as fs } from "node:fs";
      const mkdir = fs.mkdir.bind(fs);
      let stopped = false;
      fs.mkdir = async (target, options) => {
        const result = await mkdir(target, options);
        const value = String(target);
        if (!stopped && ${matches}) {
          stopped = true;
          process.stderr.write("crash-allocation:${point}\\n");
          process.kill(process.pid, "SIGSTOP");
        }
        return result;
      };
    `,
    { mode: 0o600 },
  );
  const child = spawn(
    "bun",
    [
      "--preload",
      preloadPath,
      ...collectorArgs(root, output, "record-omission"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes(`crash-allocation:${point}\n`)) resolve();
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Collector exited before ${point} allocation: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    });
  });
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function crashCollectorBeforeJournalRename(
  root: string,
  output: string,
): Promise<void> {
  const preloadPath = path.join(root, "stop-before-journal-rename.mjs");
  await fs.writeFile(
    preloadPath,
    `
      import { promises as fs } from "node:fs";
      const rename = fs.rename.bind(fs);
      let stopped = false;
      fs.rename = async (source, destination) => {
        if (
          !stopped &&
          String(source).endsWith(".tmp") &&
          String(destination).endsWith("/.corpus-transaction.json")
        ) {
          stopped = true;
          process.stderr.write("crash-journal-temporary\\n");
          process.kill(process.pid, "SIGSTOP");
        }
        return await rename(source, destination);
      };
    `,
    { mode: 0o600 },
  );
  const child = spawn(
    "bun",
    [
      "--preload",
      preloadPath,
      ...collectorArgs(root, output, "record-omission"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("crash-journal-temporary\n")) resolve();
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Collector exited before journal rename: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    });
  });
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function runCollectorWithCleanupReplacement(
  root: string,
  output: string,
): Promise<{ source: string; displaced: string }> {
  const preloadPath = path.join(root, "replace-before-cleanup-rename.mjs");
  const triggerPath = path.join(root, "cleanup-replacement.json");
  await fs.writeFile(
    preloadPath,
    `
      import path from "node:path";
      import { promises as fs } from "node:fs";
      const rename = fs.rename.bind(fs);
      let injected = false;
      fs.rename = async (source, destination) => {
        if (
          !injected &&
          String(source).endsWith(".backup") &&
          String(destination).endsWith(".removing")
        ) {
          injected = true;
          const displaced = String(source) + ".displaced";
          await rename(source, displaced);
          await fs.mkdir(source, { mode: 0o700 });
          await fs.writeFile(path.join(source, "caller-sentinel.txt"), "caller-owned", { mode: 0o600 });
          await fs.writeFile(
            ${JSON.stringify(triggerPath)},
            JSON.stringify({ source: String(source), displaced }),
            { mode: 0o600 },
          );
        }
        return await rename(source, destination);
      };
    `,
    { mode: 0o600 },
  );
  await execFileAsync(
    "bun",
    [
      "--preload",
      preloadPath,
      ...collectorArgs(root, output, "record-omission"),
    ],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(await fs.readFile(triggerPath, "utf8")) as {
    source: string;
    displaced: string;
  };
}

async function runCollectorWithPostInstallFailure(
  root: string,
  output: string,
): Promise<void> {
  const preloadPath = path.join(root, "fail-after-install.mjs");
  const triggerPath = path.join(root, "fail-after-install.triggered");
  await fs.writeFile(
    preloadPath,
    `
      import { promises as fs } from "node:fs";
      const rename = fs.rename.bind(fs);
      let injected = false;
      fs.rename = async (source, target) => {
        await rename(source, target);
        if (!injected && String(source).endsWith(".stage") && String(target).endsWith("/imessage/local")) {
          injected = true;
          await fs.writeFile(${JSON.stringify(triggerPath)}, "triggered");
          throw new Error("injected post-install failure");
        }
      };
    `,
    { mode: 0o600 },
  );
  await execFileAsync(
    "bun",
    [
      "--preload",
      preloadPath,
      ...collectorArgs(root, output, "record-omission"),
    ],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
}

async function holdCorpusLock(lockPath: string) {
  const script = `
    import { open } from "node:fs/promises";
    import { dlopen, FFIType } from "bun:ffi";
    const handle = await open(${JSON.stringify(lockPath)}, "r+");
    const library = dlopen(
      process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
    );
    if (library.symbols.flock(handle.fd, 2 | 4) !== 0) process.exit(2);
    process.stdout.write("locked\\n");
    await new Promise(() => {});
  `;
  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("exit", (code, signal) => {
      reject(
        new Error(`Lock holder exited early: code=${code} signal=${signal}`),
      );
    });
  });
  return child;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("iMessage corpus collector CLI", () => {
  it("collects through a read-only snapshot and emits a verifiable omission receipt", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "corpus-imessage-"));
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    const attachmentBytes = 300_000;
    await fs.writeFile(attachmentPath, Buffer.alloc(attachmentBytes, 0xa5));
    const dbPath = path.join(root, "chat.db");
    await createChatDb(dbPath, attachmentPath, attachmentBytes);
    const sourceBefore = await fs.readFile(dbPath);
    const sourceStatBefore = await fs.stat(dbPath, { bigint: true });

    const first = await runCollector(root, "output", "record-omission");
    const parsed = JSON.parse(first.stdout) as {
      report: {
        totals: Record<string, number>;
        unavailableAttachmentPolicy: string;
        omittedMessages: Array<{ messageIdHash: string; reason: string }>;
      };
    };
    expect(parsed.report.totals).toMatchObject({
      sourceRows: 5,
      includedMessages: 2,
      excludedReactions: 1,
      excludedSystem: 1,
      attachments: 0,
      attachmentBytes: 0,
      unavailableAttachments: 0,
      omittedMessages: 1,
      externalReplies: 1,
    });
    expect(parsed.report.unavailableAttachmentPolicy).toBe("record-omission");
    expect(parsed.report.omittedMessages).toEqual([
      {
        messageIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        reason: "empty-text-not-representable",
        attachmentCount: 1,
        attachmentBytes,
      },
    ]);
    const validation = await validateCorpusTarget(first.output);
    expect(validation.ok).toBe(true);
    expect(validation.manifest.totals.messages).toBe(2);
    const before = await Promise.all(
      validation.manifest.shards.map(
        async (entry) =>
          [
            entry.path,
            await fs.readFile(path.join(first.output, entry.path), "utf8"),
          ] as const,
      ),
    );
    const rows = before.flatMap(([, shard]) =>
      shard
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
    expect(rows.map((row) => row.id)).toEqual([
      "imessage:local:message:incoming-1",
      "imessage:local:message:outgoing-1",
    ]);
    expect(
      rows.every((row) =>
        String(row.threadId).startsWith("imessage:local:thread:"),
      ),
    ).toBe(true);
    expect(rows[1]?.replyToId).toBeUndefined();
    await expect(
      verifyIMessageCollectionReceipt(first.output, "local"),
    ).resolves.toMatchObject({ accountId: "local" });
    const verifiedByCli = await execFileAsync("bun", [
      "--conditions=eliza-source",
      path.resolve(import.meta.dirname, "../cli.ts"),
      "verify-receipt",
      "imessage",
      "--output",
      first.output,
      "--account-id",
      "local",
    ]);
    expect(JSON.parse(verifiedByCli.stdout)).toMatchObject({
      accountId: "local",
    });

    await runCollector(root, "output", "record-omission");
    const after = await Promise.all(
      validation.manifest.shards.map(
        async (entry) =>
          [
            entry.path,
            await fs.readFile(path.join(first.output, entry.path), "utf8"),
          ] as const,
      ),
    );
    expect(after).toEqual(before);
    expect(await fs.readFile(dbPath)).toEqual(sourceBefore);
    const sourceStatAfter = await fs.stat(dbPath, { bigint: true });
    expect(sourceStatAfter.size).toBe(sourceStatBefore.size);
    expect(sourceStatAfter.mtimeNs).toBe(sourceStatBefore.mtimeNs);
    expect((await fs.stat(first.output)).mode & 0o777).toBe(0o700);
    expect(
      (
        await fs.stat(
          path.join(first.output, ".eliza-imessage-corpus-root.json"),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await fs.stat(path.join(first.output, "manifest.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (
        await fs.stat(
          path.join(first.output, ".reports", "imessage-local.json"),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await fs.readdir(first.state)).some((name) =>
        name.startsWith("imessage-snapshot-"),
      ),
    ).toBe(false);
  }, 60_000);

  it("publishes included attachments as verification-compatible hash metadata", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-hash-attachment-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    const dbPath = path.join(root, "chat.db");
    await createChatDb(dbPath, attachmentPath);
    await attachFixtureToMessage(dbPath, 2);

    const result = await runCollector(root, "output", "record-omission");
    const manifest = JSON.parse(
      await fs.readFile(path.join(result.output, "manifest.json"), "utf8"),
    ) as { shards: Array<{ path: string }> };
    const messages = (
      await Promise.all(
        manifest.shards.map(async (entry) =>
          (
            await fs.readFile(path.join(result.output, entry.path), "utf8")
          )
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  id: string;
                  attachments: Array<Record<string, unknown>>;
                },
            ),
        ),
      )
    ).flat();
    const attached = messages.find((message) =>
      message.id.endsWith(":incoming-1"),
    );
    expect(attached?.attachments).toEqual([
      {
        filename: "fixture.bin",
        mimeType: "application/octet-stream",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(attached?.attachments[0]).not.toHaveProperty("bytes");
    expect(attached?.attachments[0]).not.toHaveProperty("dataBase64");
    const report = JSON.parse(
      await fs.readFile(
        path.join(result.output, ".reports", "imessage-local.json"),
        "utf8",
      ),
    ) as { totals: { attachments: number; attachmentBytes: number } };
    expect(report.totals).toMatchObject({
      attachments: 1,
      attachmentBytes: 5,
    });
    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).resolves.toMatchObject({ totals: { attachments: 1 } });
  }, 60_000);

  it("namespaces identical source identities across corpus accounts", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-accounts-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);

    const first = await runCollector(
      root,
      "output",
      "record-omission",
      "personal",
    );
    await runCollector(root, "output", "record-omission", "work");
    const validation = await validateCorpusTarget(first.output);
    expect(validation.ok).toBe(true);
    expect(validation.manifest.totals.messages).toBe(4);
    expect(
      new Set(validation.manifest.shards.map((entry) => entry.accountId)),
    ).toEqual(new Set(["personal", "work"]));
    const ids = (
      await Promise.all(
        validation.manifest.shards.map(async (entry) =>
          (
            await fs.readFile(path.join(first.output, entry.path), "utf8")
          )
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { id: string }).id),
        ),
      )
    ).flat();
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids.some((id) => id.startsWith("imessage:personal:message:"))).toBe(
      true,
    );
    expect(ids.some((id) => id.startsWith("imessage:work:message:"))).toBe(
      true,
    );
    await expect(
      verifyIMessageCollectionReceipt(first.output, "personal"),
    ).resolves.toMatchObject({ accountId: "personal" });
    await expect(
      verifyIMessageCollectionReceipt(first.output, "work"),
    ).resolves.toMatchObject({ accountId: "work" });
  }, 60_000);

  it("fails without publishing shards when attachment bytes are unavailable", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-missing-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    await createChatDb(
      path.join(root, "chat.db"),
      path.join(attachmentRoot, "missing.bin"),
    );

    await expect(runCollector(root, "failed-output")).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      fs.stat(path.join(root, "failed-output", "imessage", "local")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("records unavailable local attachments without exposing source identities", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-omission-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const missingPath = path.join(attachmentRoot, "missing.bin");
    await createChatDb(path.join(root, "chat.db"), missingPath);

    const result = await runCollector(
      root,
      "omission-output",
      "record-omission",
    );
    const reportBytes = await fs.readFile(
      path.join(result.output, ".reports", "imessage-local.json"),
      "utf8",
    );
    const report = JSON.parse(reportBytes) as {
      totals: Record<string, number>;
      unavailableAttachments: Array<{
        messageIdHash: string;
        attachmentIdHash: string;
        reason: string;
      }>;
    };
    expect(report.totals).toMatchObject({
      includedMessages: 2,
      unavailableAttachments: 1,
      omittedMessages: 1,
    });
    expect(report.unavailableAttachments).toEqual([
      {
        messageIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        attachmentIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        reason: "missing-local-file",
      },
    ]);
    expect(reportBytes).not.toContain("attachment-only");
    expect(reportBytes).not.toContain("attachment-1");
    expect(reportBytes).not.toContain(missingPath);
    await runCollector(root, "omission-output", "record-omission", "work");
    const workReport = JSON.parse(
      await fs.readFile(
        path.join(result.output, ".reports", "imessage-work.json"),
        "utf8",
      ),
    ) as typeof report;
    expect(workReport.unavailableAttachments[0]?.attachmentIdHash).not.toBe(
      report.unavailableAttachments[0]?.attachmentIdHash,
    );
    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).resolves.toMatchObject({ totals: { unavailableAttachments: 1 } });
  }, 60_000);

  it("rejects attachment paths outside the configured Messages attachment root", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-escape-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const outside = path.join(root, "outside.bin");
    await fs.writeFile(outside, "bytes");
    await createChatDb(path.join(root, "chat.db"), outside);

    await expect(
      runCollector(root, "escaped-output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      fs.stat(path.join(root, "escaped-output", "imessage", "local")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("rejects an intermediate attachment-directory symlink with descriptor-relative traversal", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-attachment-link-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    const outside = path.join(root, "outside-attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "fixture.bin"), "bytes");
    await fs.symlink(outside, path.join(attachmentRoot, "nested"));
    await createChatDb(
      path.join(root, "chat.db"),
      path.join(attachmentRoot, "nested", "fixture.bin"),
    );

    await expect(
      runCollector(root, "attachment-link-output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      fs.stat(path.join(root, "attachment-link-output", "imessage", "local")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects duplicate message GUIDs before publishing", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-duplicate-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    const dbPath = path.join(root, "chat.db");
    await createChatDb(dbPath, attachmentPath);
    await execFileAsync("/usr/bin/sqlite3", [
      dbPath,
      "UPDATE message SET guid='incoming-1' WHERE ROWID=3;",
    ]);

    await expect(runCollector(root, "duplicate-output")).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      fs.stat(path.join(root, "duplicate-output", "imessage", "local")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("rejects a FIFO attachment without blocking on its contents", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-attachment-fifo-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const fifoPath = path.join(attachmentRoot, "fixture.fifo");
    await execFileAsync("/usr/bin/mkfifo", [fifoPath]);
    await createChatDb(path.join(root, "chat.db"), fifoPath);

    await expect(
      runCollector(root, "fifo-output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      fs.stat(path.join(root, "fifo-output", "imessage", "local")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("reclaims an unlocked lock file left by a terminated collector", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "corpus-imessage-lock-"));
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const outputDir = path.join(root, "locked-output");
    await runCollector(root, "locked-output", "record-omission");
    await fs.writeFile(
      path.join(outputDir, ".corpus-collection.lock"),
      "2147483647\n",
    );

    await expect(
      runCollector(root, "locked-output", "record-omission"),
    ).resolves.toMatchObject({ output: outputDir });
    const ownerPid = await fs.readFile(
      path.join(outputDir, ".corpus-collection.lock"),
      "utf8",
    );
    expect(ownerPid).toMatch(/^\d+\n$/);
    expect(ownerPid).not.toBe("2147483647\n");
  }, 60_000);

  it("serializes collectors through the root-scoped advisory lock", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-concurrent-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(
      root,
      "shared-output",
      "record-omission",
    );
    const holder = await holdCorpusLock(
      path.join(initial.output, ".corpus-collection.lock"),
    );
    try {
      await expect(
        runCollector(root, "shared-output", "record-omission", "other"),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        verifyIMessageCollectionReceipt(initial.output, "local"),
      ).rejects.toMatchObject({
        code: "CORPUS_IMESSAGE_RECEIPT_LOCK_FAILED",
      });
    } finally {
      holder.kill("SIGKILL");
      await once(holder, "exit");
    }
    await expect(
      runCollector(root, "shared-output", "record-omission", "other"),
    ).resolves.toMatchObject({ output: initial.output });
    await expect(
      verifyIMessageCollectionReceipt(initial.output, "local"),
    ).resolves.toMatchObject({ accountId: "local" });
    expect(
      (await fs.readdir(initial.state)).some((name) =>
        name.startsWith("imessage-snapshot-"),
      ),
    ).toBe(false);
  });

  it("refuses caller-owned existing roots without chmod or cleanup", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-output-link-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const publicRoot = path.join(root, "caller-public-output");
    const privateRoot = path.join(root, "caller-private-output");
    for (const [output, mode] of [
      [publicRoot, 0o755],
      [privateRoot, 0o700],
    ] as const) {
      await fs.mkdir(output, { mode });
      await fs.chmod(output, mode);
      await fs.writeFile(path.join(output, "sentinel.txt"), "caller-owned");
      const beforeMode = (await fs.stat(output)).mode & 0o777;

      await expect(
        runCollector(root, path.basename(output), "record-omission"),
      ).rejects.toMatchObject({ code: 1 });
      expect((await fs.stat(output)).mode & 0o777).toBe(beforeMode);
      expect(await fs.readFile(path.join(output, "sentinel.txt"), "utf8")).toBe(
        "caller-owned",
      );
      expect(await fs.readdir(output)).toEqual(["sentinel.txt"]);
    }
  }, 60_000);

  it("requires an in-repository private corpus root to be gitignored", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "corpus-imessage-git-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);

    await expect(
      runCollector(root, "private-corpus", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      fs.stat(path.join(root, "private-corpus")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await fs.writeFile(path.join(root, ".gitignore"), "private-corpus/\n");
    const result = await runCollector(
      root,
      "private-corpus",
      "record-omission",
    );
    expect(result.output).toBe(path.join(root, "private-corpus"));
  }, 60_000);

  it("rejects relative collector paths resolved through a control-character cwd", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-control-cwd-"),
    );
    roots.push(root);
    const cwd = path.join(root, "unsafe\nancestor");
    await fs.mkdir(cwd, { recursive: true });
    await expect(
      execFileAsync(
        "bun",
        [
          "--conditions=eliza-source",
          path.resolve(import.meta.dirname, "../cli.ts"),
          "collect",
          "imessage",
          "--output",
          "output",
          "--account-id",
          "local",
          "--owner-id",
          "owner",
          "--owner-display",
          "Owner",
          "--db",
          "chat.db",
          "--attachment-root",
          "Attachments",
        ],
        { cwd, timeout: 30_000 },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(fs.stat(path.join(cwd, "output"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("cleans only marker-owned snapshot and generation directories", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-owned-cleanup-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const first = await runCollector(root, "output", "record-omission");
    const markerless = [
      path.join(first.state, "imessage-snapshot-unowned"),
      path.join(first.output, "imessage", ".local.unowned.stage"),
      path.join(first.output, "imessage", ".local.unowned.backup"),
    ];
    for (const directory of markerless) {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "sentinel.txt"), "unowned");
    }

    await runCollector(root, "output", "record-omission");
    for (const directory of markerless) {
      expect(
        await fs.readFile(path.join(directory, "sentinel.txt"), "utf8"),
      ).toBe("unowned");
    }
    for (const parent of [first.state, path.join(first.output, "imessage")]) {
      const recyclers = (await fs.readdir(parent)).filter((name) =>
        name.endsWith(".removing"),
      );
      expect(recyclers).toHaveLength(1);
      expect(
        await fs.readdir(path.join(parent, recyclers[0] as string)),
      ).toEqual([".eliza-imessage-owned.json"]);
    }
  }, 60_000);

  it("restores a caller replacement moved by the cleanup identity race", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-cleanup-race-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");

    const swapped = await runCollectorWithCleanupReplacement(
      root,
      initial.output,
    );
    expect(
      await fs.readFile(
        path.join(swapped.source, "caller-sentinel.txt"),
        "utf8",
      ),
    ).toBe("caller-owned");
    await expect(fs.stat(swapped.displaced)).resolves.toBeDefined();
    await expect(
      verifyIMessageCollectionReceipt(initial.output, "local"),
    ).resolves.toMatchObject({ accountId: "local" });
  }, 60_000);

  it("recovers fixed markerless root, snapshot, and stage allocations after SIGKILL", async () => {
    const rootPreparation = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-root-allocation-"),
    );
    roots.push(rootPreparation);
    const rootAttachments = path.join(rootPreparation, "Attachments");
    await fs.mkdir(rootAttachments);
    const rootAttachment = path.join(rootAttachments, "fixture.bin");
    await fs.writeFile(rootAttachment, "bytes");
    await createChatDb(path.join(rootPreparation, "chat.db"), rootAttachment);
    const rootOutput = path.join(rootPreparation, "output");
    await crashCollectorAfterAllocation(rootPreparation, rootOutput, "root");
    const preparedRoot = path.join(
      rootPreparation,
      ".output.eliza-imessage-preparing",
    );
    expect(await fs.readdir(preparedRoot)).toEqual([]);
    await fs.writeFile(
      path.join(preparedRoot, ".eliza-imessage-corpus-root.json"),
      "{",
      { mode: 0o600 },
    );
    await expect(
      runCollector(rootPreparation, "output", "record-omission"),
    ).resolves.toMatchObject({ output: rootOutput });
    await expect(fs.stat(preparedRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });

    for (const point of ["snapshot", "stage"] as const) {
      const allocationRoot = await fs.mkdtemp(
        path.join(tmpdir(), `corpus-imessage-${point}-allocation-`),
      );
      roots.push(allocationRoot);
      const attachmentRoot = path.join(allocationRoot, "Attachments");
      await fs.mkdir(attachmentRoot);
      const attachmentPath = path.join(attachmentRoot, "fixture.bin");
      await fs.writeFile(attachmentPath, "bytes");
      await createChatDb(path.join(allocationRoot, "chat.db"), attachmentPath);
      const initial = await runCollector(
        allocationRoot,
        "output",
        "record-omission",
      );
      const allocationParent =
        point === "snapshot"
          ? initial.state
          : path.join(initial.output, "imessage");
      for (const name of await fs.readdir(allocationParent)) {
        if (name.endsWith(".removing")) {
          await fs.rm(path.join(allocationParent, name), { recursive: true });
        }
      }
      await crashCollectorAfterAllocation(
        allocationRoot,
        initial.output,
        point,
      );
      const allocationName = (await fs.readdir(allocationParent)).find(
        (name) =>
          point === "snapshot"
            ? name.endsWith(".allocating")
            : name.endsWith(".stage"),
      );
      expect(allocationName).toBeDefined();
      if (!allocationName) throw new Error("allocation claim was not created");
      const allocationPath = path.join(allocationParent, allocationName);
      expect(await fs.readdir(allocationPath)).toEqual([]);
      await fs.writeFile(
        path.join(allocationPath, ".eliza-imessage-owned.json"),
        "{",
        { mode: 0o600 },
      );
      await expect(
        runCollector(allocationRoot, "output", "record-omission"),
      ).resolves.toMatchObject({ output: initial.output });
      expect(
        (await fs.readdir(initial.state)).filter((name) =>
          name.endsWith(".allocating"),
        ),
      ).toEqual([]);
      expect(
        (await fs.readdir(path.join(initial.output, "imessage"))).filter(
          (name) => name.endsWith(".stage"),
        ),
      ).toEqual([]);
    }
  }, 60_000);

  it("bounds and reclaims a SIGKILLed atomic journal temporary", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-atomic-temporary-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");

    await crashCollectorBeforeJournalRename(root, initial.output);
    await crashCollectorBeforeJournalRename(root, initial.output);
    expect(
      (await fs.readdir(initial.output)).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toHaveLength(1);
    await expect(
      runCollector(root, "output", "record-omission"),
    ).resolves.toMatchObject({ output: initial.output });
    expect(
      (await fs.readdir(initial.output)).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  }, 60_000);

  it("rejects a tampered collection receipt", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-receipt-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const result = await runCollector(root, "output", "record-omission");
    const reportPath = path.join(
      result.output,
      ".reports",
      "imessage-local.json",
    );
    const originalReport = await fs.readFile(reportPath, "utf8");
    const report = JSON.parse(originalReport) as {
      receiptHmac: string;
      omittedMessages: Array<Record<string, unknown>>;
    };
    Object.assign(report.omittedMessages[0] as Record<string, unknown>, {
      sourceGuid: "attachment-only",
    });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).rejects.toMatchObject({ code: "CORPUS_IMESSAGE_RECEIPT_INVALID" });

    await fs.writeFile(reportPath, originalReport);
    const linkageReport = JSON.parse(originalReport) as {
      receiptHmac: string;
      totals: { unavailableAttachments: number };
      unavailableAttachments: Array<{
        messageIdHash: string;
        attachmentIdHash: string;
        reason: "missing-local-file";
      }>;
    };
    linkageReport.unavailableAttachments.push({
      messageIdHash: "1".repeat(64),
      attachmentIdHash: "2".repeat(64),
      reason: "missing-local-file",
    });
    linkageReport.totals.unavailableAttachments++;
    const { receiptHmac: _receiptHmac, ...linkagePayload } = linkageReport;
    const reportKey = await fs.readFile(
      path.join(result.state, "imessage-chat-id.key"),
    );
    linkageReport.receiptHmac = createHmac("sha256", reportKey)
      .update("imessage-collection-receipt-v2")
      .update("\0")
      .update(JSON.stringify(linkagePayload))
      .digest("hex");
    await fs.writeFile(
      reportPath,
      `${JSON.stringify(linkageReport, null, 2)}\n`,
    );
    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).rejects.toMatchObject({ code: "CORPUS_IMESSAGE_RECEIPT_INVALID" });

    await fs.writeFile(reportPath, originalReport);
    const hmacReport = JSON.parse(originalReport) as { receiptHmac: string };
    hmacReport.receiptHmac = `${hmacReport.receiptHmac[0] === "0" ? "1" : "0"}${hmacReport.receiptHmac.slice(1)}`;
    await fs.writeFile(reportPath, `${JSON.stringify(hmacReport, null, 2)}\n`);

    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).rejects.toMatchObject({ code: "CORPUS_IMESSAGE_RECEIPT_HMAC_INVALID" });

    await fs.writeFile(reportPath, originalReport);
    const manifestPath = path.join(result.output, "manifest.json");
    const originalManifest = await fs.readFile(manifestPath, "utf8");
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.unexpected = true;
      },
      (value: Record<string, unknown>) => {
        const firstShard = (value.shards as Array<Record<string, unknown>>)[0];
        if (!firstShard) throw new Error("fixture manifest has no shards");
        firstShard.unexpected = true;
      },
      (value: Record<string, unknown>) => {
        (value.totals as Record<string, unknown>).unexpected = true;
      },
    ]) {
      const strictManifest = JSON.parse(originalManifest) as Record<
        string,
        unknown
      >;
      mutate(strictManifest);
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify(strictManifest, null, 2)}\n`,
      );
      await expect(
        verifyIMessageCollectionReceipt(result.output, "local"),
      ).rejects.toMatchObject({
        code: "CORPUS_IMESSAGE_RECEIPT_CORPUS_INVALID",
      });
    }
    const volatileManifest = JSON.parse(originalManifest) as {
      generatedAt: string;
    };
    volatileManifest.generatedAt = new Date(
      Date.parse(volatileManifest.generatedAt) + 1_000,
    ).toISOString();
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(volatileManifest, null, 2)}\n`,
    );
    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).resolves.toMatchObject({ accountId: "local" });
    await fs.rm(manifestPath);
    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).rejects.toMatchObject({
      code: "CORPUS_IMESSAGE_RECEIPT_CORPUS_INVALID",
    });
    await fs.writeFile(manifestPath, originalManifest, { mode: 0o600 });

    const manifest = JSON.parse(originalManifest) as {
      shards: Array<{ path: string }>;
    };
    const shardPath = manifest.shards.find((entry) =>
      entry.path.startsWith("imessage/local/"),
    )?.path;
    expect(shardPath).toBeDefined();
    await fs.appendFile(path.join(result.output, shardPath as string), "\n");
    await expect(
      verifyIMessageCollectionReceipt(result.output, "local"),
    ).rejects.toMatchObject({
      code: "CORPUS_IMESSAGE_RECEIPT_CORPUS_INVALID",
    });
  }, 60_000);

  it("fails closed on a lost published key and cleans a durable pending hardlink", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-key-durability-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");
    const keyPath = path.join(initial.state, "imessage-chat-id.key");
    const pendingPath = `${keyPath}.pending`;
    const key = await fs.readFile(keyPath);

    await fs.link(keyPath, pendingPath);
    await runCollector(root, "output", "record-omission");
    expect(await fs.readFile(keyPath)).toEqual(key);
    await expect(fs.stat(pendingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const reportPath = path.join(
      initial.output,
      ".reports",
      "imessage-local.json",
    );
    const report = await fs.readFile(reportPath);
    await fs.rm(keyPath);
    await expect(
      runCollector(root, "output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(fs.stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(reportPath)).toEqual(report);
  }, 60_000);

  it("rejects symlinked receipt state and report artifacts", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-receipt-links-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");
    const reportPath = path.join(
      initial.output,
      ".reports",
      "imessage-local.json",
    );
    const externalReport = path.join(root, "external-report.json");
    await fs.copyFile(reportPath, externalReport);
    await fs.rm(reportPath);
    await fs.symlink(externalReport, reportPath);
    await expect(
      verifyIMessageCollectionReceipt(initial.output, "local"),
    ).rejects.toBeDefined();

    await fs.rm(reportPath);
    await fs.copyFile(externalReport, reportPath);
    await fs.chmod(reportPath, 0o600);
    const realState = `${initial.state}-real`;
    await fs.rename(initial.state, realState);
    await fs.symlink(realState, initial.state);
    await expect(
      verifyIMessageCollectionReceipt(initial.output, "local"),
    ).rejects.toBeDefined();
  }, 60_000);

  it("restores the prior generation after an injected post-install failure", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-rollback-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    const dbPath = path.join(root, "chat.db");
    await createChatDb(dbPath, attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");
    const manifestBefore = await fs.readFile(
      path.join(initial.output, "manifest.json"),
    );
    const reportBefore = await fs.readFile(
      path.join(initial.output, ".reports", "imessage-local.json"),
    );
    const shardFiles = (
      JSON.parse(manifestBefore.toString("utf8")) as {
        shards: Array<{ path: string }>;
      }
    ).shards.map((entry) => path.join(initial.output, entry.path));
    const shardsBefore = await Promise.all(
      shardFiles.map((file) => fs.readFile(file)),
    );
    await execFileAsync("/usr/bin/sqlite3", [
      dbPath,
      "UPDATE message SET text = 'changed' WHERE ROWID = 2;",
    ]);

    await expect(
      runCollectorWithPostInstallFailure(root, initial.output),
    ).rejects.toBeDefined();
    await expect(
      fs.readFile(path.join(root, "fail-after-install.triggered"), "utf8"),
    ).resolves.toBe("triggered");
    expect(
      await fs.readFile(path.join(initial.output, "manifest.json")),
    ).toEqual(manifestBefore);
    expect(
      await fs.readFile(
        path.join(initial.output, ".reports", "imessage-local.json"),
      ),
    ).toEqual(reportBefore);
    expect(
      await Promise.all(shardFiles.map((file) => fs.readFile(file))),
    ).toEqual(shardsBefore);
    await expect(
      fs.stat(path.join(initial.output, ".corpus-transaction.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("retains the installed generation when a rollback backup is incomplete", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-missing-backup-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");
    await crashCollectorAtPhase(root, initial.output, "new-installed");
    const journalPath = path.join(initial.output, ".corpus-transaction.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
      backup: string;
      destination: string;
    };
    const destinationBefore = await fs.readdir(journal.destination);
    await fs.rm(journal.backup, { recursive: true });

    await expect(
      runCollector(root, "output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    expect(await fs.readdir(journal.destination)).toEqual(destinationBefore);
    await expect(fs.stat(journalPath)).resolves.toBeDefined();
  }, 60_000);

  it("rejects impossible prepared transaction destination states", async () => {
    const priorRoot = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-prepared-prior-"),
    );
    roots.push(priorRoot);
    const priorAttachments = path.join(priorRoot, "Attachments");
    await fs.mkdir(priorAttachments);
    const priorAttachment = path.join(priorAttachments, "fixture.bin");
    await fs.writeFile(priorAttachment, "bytes");
    await createChatDb(path.join(priorRoot, "chat.db"), priorAttachment);
    const prior = await runCollector(priorRoot, "output", "record-omission");
    await crashCollectorAtPhase(priorRoot, prior.output, "prepared");
    const priorJournalPath = path.join(
      prior.output,
      ".corpus-transaction.json",
    );
    const priorJournal = JSON.parse(
      await fs.readFile(priorJournalPath, "utf8"),
    ) as { backup: string; destination: string; hadDestination: boolean };
    expect(priorJournal.hadDestination).toBe(true);
    await fs.rm(priorJournal.destination, { recursive: true });
    await expect(
      runCollector(priorRoot, "output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(fs.stat(priorJournalPath)).resolves.toBeDefined();

    const newRoot = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-prepared-new-"),
    );
    roots.push(newRoot);
    const newAttachments = path.join(newRoot, "Attachments");
    await fs.mkdir(newAttachments);
    const newAttachment = path.join(newAttachments, "fixture.bin");
    await fs.writeFile(newAttachment, "bytes");
    await createChatDb(path.join(newRoot, "chat.db"), newAttachment);
    const newOutput = path.join(newRoot, "output");
    await crashCollectorAtPhase(newRoot, newOutput, "prepared");
    const newJournalPath = path.join(newOutput, ".corpus-transaction.json");
    const newJournal = JSON.parse(
      await fs.readFile(newJournalPath, "utf8"),
    ) as { destination: string; stage: string; hadDestination: boolean };
    expect(newJournal.hadDestination).toBe(false);
    await fs.rename(newJournal.stage, newJournal.destination);
    await expect(
      runCollector(newRoot, "output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(fs.stat(newJournalPath)).resolves.toBeDefined();
  }, 60_000);

  it("retains a committed backup until the installed generation validates", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-corrupt-commit-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");
    await crashCollectorAtPhase(root, initial.output, "manifest-committed");
    const journalPath = path.join(initial.output, ".corpus-transaction.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
      backup: string;
      destination: string;
    };
    const shard = (await fs.readdir(journal.destination)).find((name) =>
      name.endsWith(".jsonl"),
    );
    expect(shard).toBeDefined();
    await fs.appendFile(path.join(journal.destination, shard as string), "\n");

    await expect(
      runCollector(root, "output", "record-omission"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(fs.stat(journal.backup)).resolves.toBeDefined();
    await expect(fs.stat(journal.destination)).resolves.toBeDefined();
    await expect(fs.stat(journalPath)).resolves.toBeDefined();
  }, 60_000);

  it("recovers a committed transaction after backup quarantine is interrupted", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-quarantine-kill-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");
    await crashCollectorAfterBackupQuarantine(root, initial.output);

    await expect(
      runCollector(root, "output", "record-omission"),
    ).resolves.toMatchObject({ output: initial.output });
    await expect(
      fs.stat(path.join(initial.output, ".corpus-transaction.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const recyclers = (
      await fs.readdir(path.join(initial.output, "imessage"))
    ).filter((name) => name.endsWith(".removing"));
    expect(recyclers).toHaveLength(1);
    expect(
      await fs.readdir(
        path.join(initial.output, "imessage", recyclers[0] as string),
      ),
    ).toEqual([".eliza-imessage-owned.json"]);
  }, 60_000);

  it("recovers after the real CLI is SIGKILLed at every durable transaction phase", async () => {
    for (const phase of [
      "prepared",
      "old-moved",
      "new-installed",
      "manifest-committed",
    ]) {
      const root = await fs.mkdtemp(
        path.join(tmpdir(), `corpus-imessage-kill-${phase}-`),
      );
      roots.push(root);
      const attachmentRoot = path.join(root, "Attachments");
      await fs.mkdir(attachmentRoot, { recursive: true });
      const attachmentPath = path.join(attachmentRoot, "fixture.bin");
      await fs.writeFile(attachmentPath, "bytes");
      await createChatDb(path.join(root, "chat.db"), attachmentPath);
      const initial = await runCollector(
        root,
        "kill-output",
        "record-omission",
      );
      const lockPath = path.join(initial.output, ".corpus-collection.lock");
      const lockIdentity = await fs.stat(lockPath, { bigint: true });

      await crashCollectorAtPhase(root, initial.output, phase);
      await expect(
        fs.stat(path.join(initial.output, ".corpus-transaction.json")),
      ).resolves.toBeDefined();
      await expect(
        runCollector(root, "kill-output", "record-omission"),
      ).resolves.toMatchObject({ output: initial.output });
      const recoveredLockIdentity = await fs.stat(lockPath, { bigint: true });
      expect(recoveredLockIdentity.dev).toBe(lockIdentity.dev);
      expect(recoveredLockIdentity.ino).toBe(lockIdentity.ino);
      await expect(
        fs.stat(path.join(initial.output, ".corpus-transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await buildCorpusManifest(initial.output)).issues).toEqual([]);
      expect(
        (await fs.readdir(initial.state)).filter((entry) =>
          entry.startsWith("imessage-snapshot-"),
        ),
      ).toEqual([]);
    }
  }, 60_000);

  it("resumes rollback after SIGKILL at both durable recovery phases", async () => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), "corpus-imessage-rollback-kill-"),
    );
    roots.push(root);
    const attachmentRoot = path.join(root, "Attachments");
    await fs.mkdir(attachmentRoot);
    const attachmentPath = path.join(attachmentRoot, "fixture.bin");
    await fs.writeFile(attachmentPath, "bytes");
    await createChatDb(path.join(root, "chat.db"), attachmentPath);
    const initial = await runCollector(root, "output", "record-omission");

    await crashCollectorAtPhase(root, initial.output, "new-installed");
    await crashCollectorAtPhase(root, initial.output, "rollback-ready");
    await crashCollectorAtPhase(root, initial.output, "rollback-restored");

    await expect(
      runCollector(root, "output", "record-omission"),
    ).resolves.toMatchObject({ output: initial.output });
    await expect(
      fs.stat(path.join(initial.output, ".corpus-transaction.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      verifyIMessageCollectionReceipt(initial.output, "local"),
    ).resolves.toMatchObject({ accountId: "local" });
  }, 60_000);
});
