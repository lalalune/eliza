/**
 * Read-only iMessage history collector for the private personal corpus. It
 * snapshots chat.db through a read-only SQLite backup boundary, streams a fixed
 * ROWID window through the connector's strict reader, hashes local attachment
 * bytes through descriptor-relative traversal, and atomically replaces monthly
 * shards. All artifacts stay under a marker-owned private/gitignored root; a
 * keyed receipt makes explicit attachment and message omissions auditable.
 */
import { execFile, spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createReadStream,
  type Dirent,
  promises as fs,
  constants as fsConstants,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { ElizaError, logger } from "@elizaos/core";
import type {
  ChatDbAttachment,
  ChatDbChatSummary,
  ChatDbMessage,
  ChatDbReader,
  ChatDbSnapshot,
} from "@elizaos/plugin-imessage";
import { z } from "zod";
import {
  CORPUS_ANCHOR_MS,
  CORPUS_CUTOFF_ISO,
  CORPUS_CUTOFF_MS,
  type CorpusAttachment,
  type CorpusManifest,
  type CorpusMessage,
  type CorpusPlatform,
  corpusManifestSchema,
  corpusMessageSchema,
  corpusPlatforms,
} from "../schema.ts";
import { findCorpusShardFiles } from "../validator.ts";

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const OWNER_SALT_FILE = "imessage-chat-id.key";
const TRANSACTION_FILE = ".corpus-transaction.json";
const ROOT_MARKER_FILE = ".eliza-imessage-corpus-root.json";
const ROOT_PREPARATION_SUFFIX = ".eliza-imessage-preparing";
const OWNED_DIRECTORY_MARKER = ".eliza-imessage-owned.json";
const STATE_DIRECTORY = ".state";
const SPOOL_FILE = "messages.ndjson";
const runtimeRequire = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const rootMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("eliza-imessage-corpus-root"),
  token: z.string().uuid(),
});

type RootMarker = z.infer<typeof rootMarkerSchema>;

const ownedDirectoryMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["snapshot", "generation"]),
  rootToken: z.string().uuid(),
  nonce: z.string().uuid(),
});

const corpusTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  rootToken: z.string().uuid(),
  accountId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  phase: z.enum([
    "prepared",
    "old-moved",
    "new-installed",
    "manifest-committed",
    "rollback-ready",
    "rollback-restored",
  ]),
  destination: z.string().min(1),
  backup: z.string().min(1),
  stage: z.string().min(1),
  manifestPath: z.string().min(1),
  reportPath: z.string().min(1),
  hadDestination: z.boolean(),
  priorManifestBase64: z.string().nullable(),
  priorReportBase64: z.string().nullable(),
});

type CorpusTransaction = z.infer<typeof corpusTransactionSchema>;

interface IMessageRuntimeModule {
  DEFAULT_CHAT_DB_PATH: string;
  openChatDb(path: string): Promise<ChatDbReader | null>;
  snapshotChatDb(
    sourcePath: string,
    destinationPath: string,
  ): Promise<ChatDbSnapshot>;
}

export interface IMessageCollectorRuntime {
  defaultDbPath: string;
  openReader(path: string): Promise<ChatDbReader | null>;
  snapshot(
    sourcePath: string,
    destinationPath: string,
  ): Promise<ChatDbSnapshot>;
}

export interface CollectIMessageOptions {
  outputRoot: string;
  accountId: string;
  ownerId: string;
  ownerDisplay: string;
  ownerAddress?: string;
  dbPath?: string;
  attachmentRoot?: string;
  sinceMs?: number;
  untilMs?: number;
  pageSize?: number;
  unavailableAttachmentPolicy?: "fail" | "record-omission";
  runtime?: IMessageCollectorRuntime;
}

export interface IMessageUnavailableAttachment {
  messageIdHash: string;
  attachmentIdHash: string;
  reason: "not-local" | "missing-local-file";
}

export interface IMessageOmittedMessage {
  messageIdHash: string;
  reason: "empty-text-not-representable";
  attachmentCount: number;
  attachmentBytes: number;
}

export interface IMessageCollectionReport {
  schemaVersion: 2;
  platform: "imessage";
  accountId: string;
  sourceSnapshot: { sha256: string; bytes: number; throughRowId: number };
  window: { sinceMs: number; untilMs: number };
  unavailableAttachmentPolicy: "fail" | "record-omission";
  totals: {
    sourceRows: number;
    includedMessages: number;
    excludedReactions: number;
    excludedSystem: number;
    excludedOther: number;
    externalReplies: number;
    attachments: number;
    attachmentBytes: number;
    unavailableAttachments: number;
    omittedMessages: number;
  };
  byChat: Array<{
    chatIdHash: string;
    count: number;
    firstTs: number;
    lastTs: number;
    inCount: number;
    outCount: number;
    attachmentCount: number;
  }>;
  shardSha256: Array<{ path: string; sha256: string; count: number }>;
  unavailableAttachments: IMessageUnavailableAttachment[];
  omittedMessages: IMessageOmittedMessage[];
  accountManifestSha256: string;
  receiptHmac: string;
}

const collectionReportSchema = z
  .object({
    schemaVersion: z.literal(2),
    platform: z.literal("imessage"),
    accountId: z.string().min(1),
    sourceSnapshot: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative(),
        throughRowId: z.number().int().nonnegative(),
      })
      .strict(),
    window: z
      .object({
        sinceMs: z.number().int(),
        untilMs: z.number().int(),
      })
      .strict(),
    unavailableAttachmentPolicy: z.enum(["fail", "record-omission"]),
    totals: z
      .object({
        sourceRows: z.number().int().nonnegative(),
        includedMessages: z.number().int().nonnegative(),
        excludedReactions: z.number().int().nonnegative(),
        excludedSystem: z.number().int().nonnegative(),
        excludedOther: z.number().int().nonnegative(),
        externalReplies: z.number().int().nonnegative(),
        attachments: z.number().int().nonnegative(),
        attachmentBytes: z.number().int().nonnegative(),
        unavailableAttachments: z.number().int().nonnegative(),
        omittedMessages: z.number().int().nonnegative(),
      })
      .strict(),
    byChat: z.array(
      z
        .object({
          chatIdHash: z.string().regex(/^[a-f0-9]{64}$/),
          count: z.number().int().nonnegative(),
          firstTs: z.number().int(),
          lastTs: z.number().int(),
          inCount: z.number().int().nonnegative(),
          outCount: z.number().int().nonnegative(),
          attachmentCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    shardSha256: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    unavailableAttachments: z.array(
      z
        .object({
          messageIdHash: z.string().regex(/^[a-f0-9]{64}$/),
          attachmentIdHash: z.string().regex(/^[a-f0-9]{64}$/),
          reason: z.enum(["not-local", "missing-local-file"]),
        })
        .strict(),
    ),
    omittedMessages: z.array(
      z
        .object({
          messageIdHash: z.string().regex(/^[a-f0-9]{64}$/),
          reason: z.literal("empty-text-not-representable"),
          attachmentCount: z.number().int().nonnegative(),
          attachmentBytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    accountManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    receiptHmac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// The shared manifest schema remains additive for other collectors. Receipt
// verification needs an exact closed contract so unknown fields cannot be
// stripped before the manifest is compared and HMAC-bound.
const receiptManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z
      .string()
      .min(1)
      .refine((value) => value === value.trim()),
    cutoffIso: z.literal(CORPUS_CUTOFF_ISO),
    shards: z.array(
      z
        .object({
          path: z
            .string()
            .min(1)
            .refine((value) => value === value.trim()),
          platform: z.enum(corpusPlatforms),
          accountId: z
            .string()
            .min(1)
            .refine((value) => value === value.trim()),
          month: z.string().regex(/^\d{4}-\d{2}$/),
          count: z.number().int().nonnegative(),
          firstTs: z.number().int().min(CORPUS_CUTOFF_MS),
          lastTs: z.number().int().min(CORPUS_CUTOFF_MS),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    totals: z
      .object({
        messages: z.number().int().nonnegative(),
        contacts: z.number().int().nonnegative(),
        threads: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export interface IMessageCollectionResult {
  report: IMessageCollectionReport;
  manifest: CorpusManifest;
  reportPath: string;
  manifestPath: string;
}

async function loadRuntime(): Promise<IMessageCollectorRuntime> {
  const module = (await import(
    "@elizaos/plugin-imessage"
  )) as IMessageRuntimeModule;
  return {
    defaultDbPath: module.DEFAULT_CHAT_DB_PATH,
    openReader: module.openChatDb,
    snapshot: module.snapshotChatDb,
  };
}

function validateOptions(options: CollectIMessageOptions): {
  sinceMs: number;
  untilMs: number;
  pageSize: number;
} {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.accountId)) {
    throw new ElizaError("iMessage corpus accountId must be a path-safe slug", {
      code: "CORPUS_IMESSAGE_INVALID_ACCOUNT",
    });
  }
  if (!options.ownerId.trim() || !options.ownerDisplay.trim()) {
    throw new ElizaError("iMessage corpus owner identity is required", {
      code: "CORPUS_IMESSAGE_INVALID_OWNER",
    });
  }
  for (const [field, value] of [
    ["owner id", options.ownerId],
    ["owner display", options.ownerDisplay],
    ["owner address", options.ownerAddress],
  ] as const) {
    if (value !== undefined && containsControlCharacters(value)) {
      throw new ElizaError(`iMessage ${field} contains control characters`, {
        code: "CORPUS_IMESSAGE_INVALID_OWNER",
        context: { field },
      });
    }
  }
  if (
    options.unavailableAttachmentPolicy !== undefined &&
    options.unavailableAttachmentPolicy !== "fail" &&
    options.unavailableAttachmentPolicy !== "record-omission"
  ) {
    throw new ElizaError("Invalid unavailable attachment policy", {
      code: "CORPUS_IMESSAGE_INVALID_ATTACHMENT_POLICY",
    });
  }
  const sinceMs = options.sinceMs ?? CORPUS_CUTOFF_MS;
  const untilMs = options.untilMs ?? CORPUS_ANCHOR_MS;
  if (
    !Number.isSafeInteger(sinceMs) ||
    !Number.isSafeInteger(untilMs) ||
    sinceMs < CORPUS_CUTOFF_MS ||
    untilMs > CORPUS_ANCHOR_MS ||
    untilMs <= sinceMs
  ) {
    throw new ElizaError(
      "iMessage collection window must stay within the canonical corpus window",
      {
        code: "CORPUS_IMESSAGE_INVALID_WINDOW",
        context: { sinceMs, untilMs },
      },
    );
  }
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new ElizaError(
      "iMessage collection page size must be between 1 and 1000",
      {
        code: "CORPUS_IMESSAGE_INVALID_PAGE_SIZE",
        context: { pageSize },
      },
    );
  }
  return { sinceMs, untilMs, pageSize };
}

async function assertSeparatedPaths(
  outputRoot: string,
  dbPath: string,
): Promise<void> {
  const output = path.resolve(outputRoot);
  const source = path.resolve(dbPath);
  const overlaps = (left: string, right: string) => {
    const relative = path.relative(left, right);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== "..")
    );
  };
  if (overlaps(output, source) || overlaps(source, output)) {
    throw new ElizaError(
      "iMessage source and private corpus root must not overlap",
      {
        code: "CORPUS_IMESSAGE_PATH_OVERLAP",
      },
    );
  }
}

async function assertNoSymlinkComponents(targetPath: string): Promise<void> {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        const macSystemAlias =
          (current === "/var" || current === "/tmp") &&
          (await fs.realpath(current)).startsWith("/private/");
        if (macSystemAlias) continue;
        throw new ElizaError(
          "iMessage collector paths may not contain symlink components",
          {
            code: "CORPUS_IMESSAGE_UNSAFE_PATH",
            context: { path: current },
          },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // error-policy:J2 Path-component validation preserves the filesystem cause.
      throw error;
    }
  }
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

async function directoryIdentity(
  directory: string,
): Promise<DirectoryIdentity> {
  const stat = await fs.stat(directory, { bigint: true });
  if (!stat.isDirectory()) {
    throw new ElizaError("iMessage collector destination must be a directory", {
      code: "CORPUS_IMESSAGE_UNSAFE_PATH",
      context: { path: directory },
    });
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryUnchanged(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  let current: DirectoryIdentity;
  try {
    await assertNoSymlinkComponents(directory);
    current = await directoryIdentity(directory);
  } catch (error) {
    // error-policy:J2 Directory-identity failures retain the filesystem cause that made the path unsafe.
    throw new ElizaError(
      "iMessage collector destination changed during collection",
      {
        code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED",
        cause: error,
        context: { path: directory },
      },
    );
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new ElizaError(
      "iMessage collector destination changed during collection",
      {
        code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED",
        context: { path: directory },
      },
    );
  }
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function assertPathHasNoControlCharacters(value: string, field: string): void {
  if (!value || containsControlCharacters(value)) {
    throw new ElizaError(`iMessage ${field} contains control characters`, {
      code: "CORPUS_IMESSAGE_UNSAFE_PATH",
      context: { field },
    });
  }
}

async function nearestExistingDirectory(targetPath: string): Promise<string> {
  let candidate = path.resolve(targetPath);
  for (;;) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) candidate = path.dirname(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // error-policy:J3 Missing path components are expected before private-root creation.
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function commandFailure(error: unknown): {
  code: number | undefined;
  stderr: string;
} {
  if (!(error instanceof Error)) return { code: undefined, stderr: "" };
  const code =
    "code" in error && typeof error.code === "number" ? error.code : undefined;
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return { code, stderr };
}

async function assertPrivateRootIsGitIgnored(
  privateRoot: string,
): Promise<void> {
  const existingAncestor = await nearestExistingDirectory(privateRoot);
  const canonicalAncestor = await fs.realpath(existingAncestor);
  const canonicalPrivateRoot = path.resolve(
    canonicalAncestor,
    path.relative(existingAncestor, privateRoot),
  );
  assertPathHasNoControlCharacters(
    canonicalPrivateRoot,
    "canonical private root",
  );
  let gitRoot: string;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", canonicalAncestor, "rev-parse", "--show-toplevel"],
      { maxBuffer: 64 * 1024 },
    );
    gitRoot = result.stdout.trim();
  } catch (error) {
    // error-policy:J3 A non-repository destination needs no gitignore proof.
    const failure = commandFailure(error);
    if (
      failure.code === 128 &&
      /not a git repository|not in a git directory/i.test(failure.stderr)
    ) {
      return;
    }
    // error-policy:J2 Git discovery failures other than “not a repository” make privacy unverifiable.
    throw new ElizaError("Unable to determine the corpus root git boundary", {
      code: "CORPUS_IMESSAGE_GIT_CHECK_FAILED",
      cause: error,
    });
  }

  const relative = path.relative(gitRoot, canonicalPrivateRoot);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ElizaError(
      "The iMessage corpus root must be a gitignored subdirectory, not a repository root",
      { code: "CORPUS_IMESSAGE_ROOT_NOT_PRIVATE" },
    );
  }

  try {
    await execFileAsync(
      "git",
      ["-C", gitRoot, "ls-files", "--error-unmatch", "--", relative],
      { maxBuffer: 64 * 1024 },
    );
    throw new ElizaError("The iMessage corpus root is already tracked by git", {
      code: "CORPUS_IMESSAGE_ROOT_TRACKED",
    });
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J3 An untracked path is the required precondition.
    if (commandFailure(error).code === 1) {
      // `git ls-files --error-unmatch` reserves status 1 for an untracked path.
    } else {
      // error-policy:J2 Unexpected index failures make repository privacy unverifiable.
      throw new ElizaError("Unable to inspect the corpus root git index", {
        code: "CORPUS_IMESSAGE_GIT_CHECK_FAILED",
        cause: error,
      });
    }
  }

  try {
    const ignoredDirectory = `${relative.split(path.sep).join("/")}/`;
    await execFileAsync(
      "git",
      [
        "-C",
        gitRoot,
        "check-ignore",
        "--quiet",
        "--no-index",
        "--",
        ignoredDirectory,
      ],
      { maxBuffer: 64 * 1024 },
    );
  } catch (error) {
    // error-policy:J3 A non-ignored path is the explicit unsafe result.
    if (commandFailure(error).code === 1) {
      throw new ElizaError(
        "The iMessage corpus root is inside a repository but is not gitignored",
        { code: "CORPUS_IMESSAGE_ROOT_NOT_IGNORED" },
      );
    }
    // error-policy:J2 Unexpected ignore-engine failures make repository privacy unverifiable.
    throw new ElizaError("Unable to inspect corpus gitignore coverage", {
      code: "CORPUS_IMESSAGE_GIT_CHECK_FAILED",
      cause: error,
    });
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ElizaError(
      "An iMessage collector-owned path is not a regular directory",
      {
        code: "CORPUS_IMESSAGE_UNSAFE_PATH",
      },
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ElizaError(
      "An iMessage collector-owned directory is not private",
      {
        code: "CORPUS_IMESSAGE_ROOT_NOT_PRIVATE",
      },
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ElizaError(
      "An iMessage collector-owned directory belongs to another user",
      { code: "CORPUS_IMESSAGE_ROOT_NOT_PRIVATE" },
    );
  }
}

async function readRootMarker(privateRoot: string): Promise<RootMarker> {
  const markerPath = path.join(privateRoot, ROOT_MARKER_FILE);
  const handle = await fs.open(
    markerPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid()))
    ) {
      throw new ElizaError("The iMessage corpus ownership marker is unsafe", {
        code: "CORPUS_IMESSAGE_ROOT_MARKER_INVALID",
      });
    }
    const marker = rootMarkerSchema.parse(
      JSON.parse(await handle.readFile({ encoding: "utf8" })),
    );
    const current = await fs.lstat(markerPath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    ) {
      throw new ElizaError("The iMessage corpus ownership marker changed", {
        code: "CORPUS_IMESSAGE_ROOT_MARKER_INVALID",
      });
    }
    return marker;
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 Ownership-marker parsing preserves the invalid artifact cause.
    throw new ElizaError("The iMessage corpus ownership marker is invalid", {
      code: "CORPUS_IMESSAGE_ROOT_MARKER_INVALID",
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

async function writeRootMarker(
  privateRoot: string,
  marker: RootMarker,
): Promise<void> {
  const markerPath = path.join(privateRoot, ROOT_MARKER_FILE);
  const handle = await fs.open(markerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(privateRoot);
}

async function assertPrivateRegularFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new ElizaError("A collector-owned control file is unsafe", {
      code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
      context: { filePath },
    });
  }
}

async function preparedRootMarker(preparedRoot: string): Promise<RootMarker> {
  await assertPrivateDirectory(preparedRoot);
  const entries = await fs.readdir(preparedRoot);
  if (entries.length === 0) {
    const marker: RootMarker = {
      schemaVersion: 1,
      kind: "eliza-imessage-corpus-root",
      token: randomUUID(),
    };
    await writeRootMarker(preparedRoot, marker);
    return marker;
  }
  if (entries.length !== 1 || entries[0] !== ROOT_MARKER_FILE) {
    throw new ElizaError(
      "The prepared iMessage corpus root contains unowned artifacts",
      { code: "CORPUS_IMESSAGE_ROOT_MARKER_INVALID" },
    );
  }
  try {
    return await readRootMarker(preparedRoot);
  } catch (_error) {
    // error-policy:J3 The fixed preparation claim contains no corpus bytes, so a
    // process-killed partial marker is the only invalid artifact it may repair.
    await assertPrivateRegularFile(path.join(preparedRoot, ROOT_MARKER_FILE));
    await fs.rm(path.join(preparedRoot, ROOT_MARKER_FILE));
    await syncDirectory(preparedRoot);
    const marker: RootMarker = {
      schemaVersion: 1,
      kind: "eliza-imessage-corpus-root",
      token: randomUUID(),
    };
    await writeRootMarker(preparedRoot, marker);
    return marker;
  }
}

async function ensureOwnedPrivateRoot(requestedRoot: string): Promise<{
  root: string;
  marker: RootMarker;
}> {
  assertPathHasNoControlCharacters(requestedRoot, "private root");
  const privateRoot = path.resolve(requestedRoot);
  assertPathHasNoControlCharacters(privateRoot, "resolved private root");
  if (privateRoot === path.parse(privateRoot).root) {
    throw new ElizaError(
      "The iMessage corpus root cannot be a filesystem root",
      {
        code: "CORPUS_IMESSAGE_ROOT_NOT_PRIVATE",
      },
    );
  }
  await assertPrivateRootIsGitIgnored(privateRoot);
  await assertNoSymlinkComponents(privateRoot);
  let exists = true;
  try {
    await fs.lstat(privateRoot);
  } catch (error) {
    // error-policy:J3 First-run absence selects prepared exclusive publication.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
    else throw error;
  }
  if (!exists) {
    const parent = path.dirname(privateRoot);
    const preparedRoot = path.join(
      parent,
      `.${path.basename(privateRoot)}${ROOT_PREPARATION_SUFFIX}`,
    );
    try {
      await fs.mkdir(preparedRoot, { mode: 0o700 });
    } catch (error) {
      // error-policy:J3 A fixed preparation claim is resumed after a concurrent
      // first run or process termination; every other allocation error fails.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await preparedRootMarker(preparedRoot);
    await syncDirectory(parent);
    try {
      await renameDirectoryExclusive(preparedRoot, privateRoot);
    } catch (error) {
      // error-policy:J4 A concurrent first collector may have published the
      // same fixed preparation claim before this process reached the rename.
      try {
        await assertPrivateDirectory(privateRoot);
        await readRootMarker(privateRoot);
      } catch {
        // error-policy:J2 Preserve the exclusive-publication failure unless a
        // complete private root is observably present at the destination.
        throw error;
      }
    }
    await syncDirectory(parent);
    await assertNoSymlinkComponents(privateRoot);
    await assertPrivateDirectory(privateRoot);
    const root = await fs.realpath(privateRoot);
    assertPathHasNoControlCharacters(root, "canonical private root");
    return { root, marker: await readRootMarker(privateRoot) };
  }
  await assertNoSymlinkComponents(privateRoot);
  await assertPrivateDirectory(privateRoot);
  const root = await fs.realpath(privateRoot);
  assertPathHasNoControlCharacters(root, "canonical private root");
  return {
    root,
    marker: await readRootMarker(privateRoot),
  };
}

async function writeOwnedDirectoryMarker(
  directory: string,
  kind: "snapshot" | "generation",
  rootToken: string,
): Promise<void> {
  const marker = {
    schemaVersion: 1 as const,
    kind,
    rootToken,
    nonce: randomUUID(),
  };
  const handle = await fs.open(
    path.join(directory, OWNED_DIRECTORY_MARKER),
    "wx",
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

type OwnedDirectoryInspection =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "owned"; identity: DirectoryIdentity };

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectOwnedDirectory(
  directory: string,
  kind: "snapshot" | "generation",
  rootToken: string,
): Promise<OwnedDirectoryInspection> {
  try {
    const directoryStat = await fs.lstat(directory, { bigint: true });
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" &&
        directoryStat.uid !== BigInt(process.getuid()))
    ) {
      return { status: "invalid" };
    }
    const markerPath = path.join(directory, OWNED_DIRECTORY_MARKER);
    const markerHandle = await fs.open(
      markerPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    let raw: string;
    try {
      const markerStat = await markerHandle.stat({ bigint: true });
      if (
        !markerStat.isFile() ||
        (markerStat.mode & 0o077n) !== 0n ||
        (typeof process.getuid === "function" &&
          markerStat.uid !== BigInt(process.getuid()))
      ) {
        return { status: "invalid" };
      }
      raw = await markerHandle.readFile({ encoding: "utf8" });
    } finally {
      await markerHandle.close();
    }
    const marker = ownedDirectoryMarkerSchema.parse(JSON.parse(raw));
    const after = await fs.lstat(directory, { bigint: true });
    const identity = { dev: directoryStat.dev, ino: directoryStat.ino };
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameDirectoryIdentity(identity, { dev: after.dev, ino: after.ino }) ||
      marker.kind !== kind ||
      marker.rootToken !== rootToken
    ) {
      return { status: "invalid" };
    }
    return { status: "owned", identity };
  } catch (error) {
    // error-policy:J3 Missing or malformed markers explicitly mean “not collector-owned”.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return (await pathExists(directory))
        ? { status: "invalid" }
        : { status: "missing" };
    }
    if (
      (error as NodeJS.ErrnoException).code === "ELOOP" ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    )
      return { status: "invalid" };
    throw error;
  }
}

async function hasOwnedDirectoryMarker(
  directory: string,
  kind: "snapshot" | "generation",
  rootToken: string,
): Promise<boolean> {
  return (
    (await inspectOwnedDirectory(directory, kind, rootToken)).status === "owned"
  );
}

function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith(`~${path.sep}`)
      ? path.join(homedir(), value.slice(2))
      : value;
}

interface OpenAtLibrary {
  symbols: {
    openat(directoryFd: number, pathPointer: object, flags: number): number;
    close(fd: number): number;
  };
  close(): void;
}

interface FlockLibrary {
  symbols: {
    flock(fd: number, operation: number): number;
  };
  close(): void;
}

interface DirectoryMutationLibrary {
  symbols: {
    openat(directoryFd: number, pathPointer: object, flags: number): number;
    unlinkat(directoryFd: number, pathPointer: object, flags: number): number;
    dup(fd: number): number;
    fdopendir(fd: number): number;
    rewinddir(directoryPointer: number): void;
    readdir(directoryPointer: number): number;
    closedir(directoryPointer: number): number;
    close(fd: number): number;
  };
  close(): void;
}

interface ExclusiveRenameLibrary {
  symbols: {
    renamex_np?: (
      sourcePointer: object,
      destinationPointer: object,
      flags: number,
    ) => number;
    renameat2?: (
      sourceDirectoryFd: number,
      sourcePointer: object,
      destinationDirectoryFd: number,
      destinationPointer: object,
      flags: number,
    ) => number;
  };
  close(): void;
}

interface BunFfiModule {
  FFIType: { i32: number; cstring: number; ptr: number; void: number };
  CString: new (
    pointer: number,
    byteOffset?: number,
    byteLength?: number,
  ) => { toString(): string };
  ptr(bytes: Uint8Array): object;
  read: { u16(pointer: number, byteOffset?: number): number };
  dlopen(
    library: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ):
    | OpenAtLibrary
    | FlockLibrary
    | DirectoryMutationLibrary
    | ExclusiveRenameLibrary;
}

function readDirectoryNames(
  directoryFd: number,
  ffi: BunFfiModule,
  library: DirectoryMutationLibrary,
): string[] {
  const duplicatedFd = library.symbols.dup(directoryFd);
  if (duplicatedFd < 0) {
    throw new ElizaError("Unable to duplicate a collector directory handle", {
      code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
    });
  }
  const directoryPointer = library.symbols.fdopendir(duplicatedFd);
  if (!directoryPointer) {
    library.symbols.close(duplicatedFd);
    throw new ElizaError("Unable to enumerate a collector directory handle", {
      code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
    });
  }
  const names: string[] = [];
  try {
    library.symbols.rewinddir(directoryPointer);
    for (;;) {
      const entryPointer = library.symbols.readdir(directoryPointer);
      if (!entryPointer) break;
      const name =
        process.platform === "darwin"
          ? new ffi.CString(
              entryPointer,
              21,
              ffi.read.u16(entryPointer, 18),
            ).toString()
          : new ffi.CString(
              entryPointer,
              19,
              Math.max(0, ffi.read.u16(entryPointer, 16) - 19),
            ).toString();
      if (name !== "." && name !== "..") names.push(name);
    }
  } finally {
    if (library.symbols.closedir(directoryPointer) !== 0) {
      logger.warn("[CorpusTools] Failed to close a native directory stream");
    }
  }
  return names;
}

function nativeLibraryPath(): string {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new ElizaError(
    "Descriptor-relative filesystem operations are unsupported on this platform",
    {
      code: "CORPUS_IMESSAGE_OPENAT_UNAVAILABLE",
      context: { platform: process.platform },
    },
  );
}

function descriptorPath(fd: number): string {
  return process.platform === "darwin"
    ? `/dev/fd/${fd}`
    : `/proc/self/fd/${fd}`;
}

async function renameDirectoryExclusive(
  source: string,
  destination: string,
): Promise<void> {
  let ffi: BunFfiModule;
  try {
    ffi = runtimeRequire("bun:ffi") as BunFfiModule;
  } catch (error) {
    // error-policy:J2 Root publication requires a kernel no-replace rename primitive.
    throw new ElizaError("Bun FFI is required for private-root publication", {
      code: "CORPUS_IMESSAGE_OPENAT_UNAVAILABLE",
      cause: error,
    });
  }
  const encoder = new TextEncoder();
  const sourceBytes = encoder.encode(`${source}\0`);
  const destinationBytes = encoder.encode(`${destination}\0`);
  let library: ExclusiveRenameLibrary;
  let result: number;
  if (process.platform === "darwin") {
    library = ffi.dlopen(nativeLibraryPath(), {
      renamex_np: {
        args: [ffi.FFIType.cstring, ffi.FFIType.cstring, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
    }) as ExclusiveRenameLibrary;
    result =
      library.symbols.renamex_np?.(
        ffi.ptr(sourceBytes),
        ffi.ptr(destinationBytes),
        0x4,
      ) ?? -1;
  } else {
    library = ffi.dlopen(nativeLibraryPath(), {
      renameat2: {
        args: [
          ffi.FFIType.i32,
          ffi.FFIType.cstring,
          ffi.FFIType.i32,
          ffi.FFIType.cstring,
          ffi.FFIType.i32,
        ],
        returns: ffi.FFIType.i32,
      },
    }) as ExclusiveRenameLibrary;
    result =
      library.symbols.renameat2?.(
        -100,
        ffi.ptr(sourceBytes),
        -100,
        ffi.ptr(destinationBytes),
        0x1,
      ) ?? -1;
  }
  library.close();
  if (result !== 0) {
    throw new ElizaError(
      "Unable to publish the prepared private corpus root without replacement",
      { code: "CORPUS_IMESSAGE_ROOT_PUBLICATION_FAILED" },
    );
  }
}

async function openContainedFile(
  rootPath: string,
  requestedPath: string,
  expectedRoot: DirectoryIdentity,
) {
  const lexicalRoot = path.resolve(rootPath);
  const lexicalTarget = path.resolve(requestedPath);
  assertPathHasNoControlCharacters(lexicalRoot, "resolved attachment root");
  assertPathHasNoControlCharacters(lexicalTarget, "resolved attachment path");
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ElizaError(
      "iMessage attachment resolved outside the allowed attachment root",
      { code: "CORPUS_IMESSAGE_ATTACHMENT_PATH_ESCAPE" },
    );
  }
  const components = relative.split(path.sep).filter(Boolean);
  const filename = components.pop();
  if (!filename) {
    throw new ElizaError("iMessage attachment path has no file component", {
      code: "CORPUS_IMESSAGE_ATTACHMENT_INVALID",
    });
  }
  let ffi: BunFfiModule;
  try {
    ffi = runtimeRequire("bun:ffi") as BunFfiModule;
  } catch (error) {
    // error-policy:J2 Descriptor-relative traversal requires the Bun CLI runtime.
    throw new ElizaError("Bun FFI is required for safe attachment traversal", {
      code: "CORPUS_IMESSAGE_OPENAT_UNAVAILABLE",
      cause: error,
    });
  }
  const library = ffi.dlopen(nativeLibraryPath(), {
    openat: {
      args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
    close: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
  }) as OpenAtLibrary;
  await assertNoSymlinkComponents(lexicalRoot);
  await assertDirectoryUnchanged(lexicalRoot, expectedRoot);
  const canonicalRoot = await fs.realpath(lexicalRoot);
  assertPathHasNoControlCharacters(canonicalRoot, "canonical attachment root");
  const filesystemRoot = path.parse(canonicalRoot).root;
  const anchorHandle = await fs.open(
    filesystemRoot,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  const openedDescriptors: number[] = [];
  const encoder = new TextEncoder();
  const openRelative = (
    directoryFd: number,
    component: string,
    flags: number,
  ): number => {
    const bytes = encoder.encode(`${component}\0`);
    const fd = library.symbols.openat(directoryFd, ffi.ptr(bytes), flags);
    if (fd < 0) {
      throw new ElizaError(
        "Unable to open an iMessage attachment path component safely",
        { code: "CORPUS_IMESSAGE_ATTACHMENT_OPEN_FAILED" },
      );
    }
    openedDescriptors.push(fd);
    return fd;
  };
  try {
    let directoryFd = anchorHandle.fd;
    const rootComponents = path
      .relative(filesystemRoot, canonicalRoot)
      .split(path.sep)
      .filter(Boolean);
    for (const component of rootComponents) {
      directoryFd = openRelative(
        directoryFd,
        component,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
    }
    const rootDescriptorPath = descriptorPath(directoryFd);
    const verifiedRoot = await fs.open(
      rootDescriptorPath,
      fsConstants.O_RDONLY,
    );
    try {
      const actualRoot = await verifiedRoot.stat({ bigint: true });
      if (
        actualRoot.dev !== expectedRoot.dev ||
        actualRoot.ino !== expectedRoot.ino
      ) {
        throw new ElizaError(
          "iMessage attachment root changed during descriptor acquisition",
          { code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED" },
        );
      }
    } finally {
      await verifiedRoot.close();
    }
    for (const component of components) {
      directoryFd = openRelative(
        directoryFd,
        component,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
    }
    const fileFd = openRelative(
      directoryFd,
      filename,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    return await fs.open(descriptorPath(fileFd), fsConstants.O_RDONLY);
  } finally {
    for (const descriptor of openedDescriptors.reverse()) {
      if (library.symbols.close(descriptor) !== 0) {
        logger.warn(
          "[CorpusTools] Failed to close a descriptor-relative attachment handle",
        );
      }
    }
    await anchorHandle.close();
    library.close();
  }
}

function assertAttachmentPathContained(
  rootPath: string,
  requestedPath: string,
): void {
  const relative = path.relative(
    path.resolve(rootPath),
    path.resolve(requestedPath),
  );
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ElizaError(
      "iMessage attachment resolved outside the allowed attachment root",
      { code: "CORPUS_IMESSAGE_ATTACHMENT_PATH_ESCAPE" },
    );
  }
}

type AttachmentHashResult =
  | {
      status: "available";
      attachment: CorpusAttachment & { bytes: number };
    }
  | {
      status: "unavailable";
      reason: IMessageUnavailableAttachment["reason"];
    };

async function hashAttachment(
  attachment: ChatDbAttachment,
  attachmentRoot: string,
  attachmentRootIdentity: DirectoryIdentity,
): Promise<AttachmentHashResult> {
  if (!attachment.path) {
    return { status: "unavailable", reason: "not-local" };
  }
  assertPathHasNoControlCharacters(attachment.path, "attachment path");
  const requestedPath = path.resolve(expandHome(attachment.path));
  assertPathHasNoControlCharacters(requestedPath, "resolved attachment path");
  assertAttachmentPathContained(attachmentRoot, requestedPath);
  await assertDirectoryUnchanged(attachmentRoot, attachmentRootIdentity);
  try {
    await fs.lstat(requestedPath);
  } catch (error) {
    // error-policy:J3 An iCloud-evicted or otherwise absent local payload is explicit unavailable state.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertDirectoryUnchanged(attachmentRoot, attachmentRootIdentity);
      return { status: "unavailable", reason: "missing-local-file" };
    }
    throw error;
  }
  const handle = await openContainedFile(
    attachmentRoot,
    requestedPath,
    attachmentRootIdentity,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ElizaError("iMessage attachment is not a regular file", {
        code: "CORPUS_IMESSAGE_ATTACHMENT_INVALID",
        context: { attachmentGuid: attachment.guid },
      });
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new ElizaError("iMessage attachment changed while it was hashed", {
        code: "CORPUS_IMESSAGE_ATTACHMENT_CHANGED",
        context: { attachmentGuid: attachment.guid },
      });
    }
    const bytes = Number(after.size);
    if (
      !Number.isSafeInteger(bytes) ||
      (attachment.totalBytes !== null && attachment.totalBytes !== bytes)
    ) {
      throw new ElizaError("iMessage attachment size does not match chat.db", {
        code: "CORPUS_IMESSAGE_ATTACHMENT_SIZE_MISMATCH",
        context: {
          attachmentGuid: attachment.guid,
          databaseBytes: attachment.totalBytes,
          actualBytes: bytes,
        },
      });
    }
    return {
      status: "available",
      attachment: {
        filename: path.basename(attachment.transferName ?? attachment.path),
        mimeType: attachment.mimeType ?? "application/octet-stream",
        sha256: hash.digest("hex"),
        bytes,
      },
    };
  } finally {
    await handle.close();
  }
}

interface CollectionTotals {
  sourceRows: number;
  includedMessages: number;
  excludedReactions: number;
  excludedSystem: number;
  excludedOther: number;
  externalReplies: number;
  attachments: number;
  attachmentBytes: number;
  unavailableAttachments: number;
  omittedMessages: number;
}

interface ChatStatistics {
  chatIdHash: string;
  count: number;
  firstTs: number;
  lastTs: number;
  inCount: number;
  outCount: number;
  attachmentCount: number;
}

interface CollectionAccumulator {
  totals: CollectionTotals;
  byChat: Map<string, ChatStatistics>;
  unavailableAttachments: IMessageUnavailableAttachment[];
  omittedMessages: IMessageOmittedMessage[];
}

const spoolRecordSchema = z.object({
  message: corpusMessageSchema,
  sourceReplyId: z.string().min(1).optional(),
});

type SpoolRecord = z.infer<typeof spoolRecordSchema>;

function namespaceId(
  accountId: string,
  kind: string,
  sourceId: string,
): string {
  return `imessage:${accountId}:${kind}:${sourceId}`;
}

function receiptIdentifier(
  reportKey: Buffer,
  kind: string,
  sourceId: string,
): string {
  return createHmac("sha256", reportKey)
    .update(kind)
    .update("\0")
    .update(sourceId)
    .digest("hex");
}

function createAccumulator(): CollectionAccumulator {
  return {
    totals: {
      sourceRows: 0,
      includedMessages: 0,
      excludedReactions: 0,
      excludedSystem: 0,
      excludedOther: 0,
      externalReplies: 0,
      attachments: 0,
      attachmentBytes: 0,
      unavailableAttachments: 0,
      omittedMessages: 0,
    },
    byChat: new Map(),
    unavailableAttachments: [],
    omittedMessages: [],
  };
}

function recipientsFor(
  row: ChatDbMessage,
  chats: ReadonlyMap<string, ChatDbChatSummary>,
  accountId: string,
  owner: { id: string; display: string; address?: string },
) {
  const chat = chats.get(row.chatId);
  if (!chat) {
    throw new ElizaError("iMessage row has no matching chat metadata", {
      code: "CORPUS_IMESSAGE_MISSING_CHAT",
      context: { rowId: row.rowId },
    });
  }
  const participants = [
    ...new Set(
      chat.participants
        .map((participant) => participant.trim())
        .filter(Boolean),
    ),
  ]
    .sort()
    .filter((participant) => participant !== owner.address);
  if (!row.isFromMe) {
    const recipients = [
      {
        id: owner.id,
        display: owner.display,
        ...(owner.address ? { address: owner.address } : {}),
      },
    ];
    for (const participant of participants) {
      if (participant !== row.handle) {
        recipients.push({
          id: namespaceId(accountId, "handle", participant),
          display: participant,
          address: participant,
        });
      }
    }
    return recipients;
  }
  return participants.map((participant) => ({
    id: namespaceId(accountId, "handle", participant),
    display: participant,
    address: participant,
  }));
}

function recordChatStatistics(
  accumulator: CollectionAccumulator,
  message: CorpusMessage,
  reportKey: Buffer,
): void {
  const chatIdHash = receiptIdentifier(reportKey, "chat", message.threadId);
  const current = accumulator.byChat.get(chatIdHash) ?? {
    chatIdHash,
    count: 0,
    firstTs: message.ts,
    lastTs: message.ts,
    inCount: 0,
    outCount: 0,
    attachmentCount: 0,
  };
  current.count++;
  current.firstTs = Math.min(current.firstTs, message.ts);
  current.lastTs = Math.max(current.lastTs, message.ts);
  current[message.direction === "in" ? "inCount" : "outCount"]++;
  current.attachmentCount += message.attachments.length;
  accumulator.byChat.set(chatIdHash, current);
}

function accountOwner(options: CollectIMessageOptions) {
  return {
    id: namespaceId(options.accountId, "owner", options.ownerId.trim()),
    display: options.ownerDisplay.trim(),
    address: options.ownerAddress?.trim(),
  };
}

async function mapMessageToSpool(
  row: ChatDbMessage,
  chats: ReadonlyMap<string, ChatDbChatSummary>,
  options: CollectIMessageOptions,
  attachmentRoot: string,
  attachmentRootIdentity: DirectoryIdentity,
  reportKey: Buffer,
  accumulator: CollectionAccumulator,
): Promise<SpoolRecord | null> {
  accumulator.totals.sourceRows++;
  if (row.kind === "reaction") {
    accumulator.totals.excludedReactions++;
    return null;
  }
  if (row.kind === "system") {
    accumulator.totals.excludedSystem++;
    return null;
  }
  if (row.kind !== "text") {
    accumulator.totals.excludedOther++;
    return null;
  }
  if (!row.guid.trim() || !row.chatId.trim()) {
    throw new ElizaError("iMessage row is missing a message or chat identity", {
      code: "CORPUS_IMESSAGE_MISSING_IDENTITY",
      context: { rowId: row.rowId },
    });
  }

  const messageId = namespaceId(options.accountId, "message", row.guid);
  const attachments: Array<CorpusAttachment & { bytes: number }> = [];
  for (const sourceAttachment of row.attachments) {
    const hashed = await hashAttachment(
      sourceAttachment,
      attachmentRoot,
      attachmentRootIdentity,
    );
    if (hashed.status === "unavailable") {
      accumulator.totals.unavailableAttachments++;
      accumulator.unavailableAttachments.push({
        messageIdHash: receiptIdentifier(reportKey, "message", messageId),
        attachmentIdHash: receiptIdentifier(
          reportKey,
          "attachment",
          namespaceId(options.accountId, "attachment", sourceAttachment.guid),
        ),
        reason: hashed.reason,
      });
      if ((options.unavailableAttachmentPolicy ?? "fail") === "fail") {
        throw new ElizaError(
          "An iMessage attachment is not available locally",
          {
            code: "CORPUS_IMESSAGE_ATTACHMENT_UNAVAILABLE",
            context: { rowId: row.rowId, reason: hashed.reason },
          },
        );
      }
      continue;
    }
    attachments.push(hashed.attachment);
  }

  const text = row.text.trim();
  if (!text) {
    const attachmentBytes = attachments.reduce(
      (sum, attachment) => sum + attachment.bytes,
      0,
    );
    accumulator.totals.omittedMessages++;
    accumulator.omittedMessages.push({
      messageIdHash: receiptIdentifier(reportKey, "message", messageId),
      reason: "empty-text-not-representable",
      attachmentCount: attachments.length,
      attachmentBytes,
    });
    if ((options.unavailableAttachmentPolicy ?? "fail") === "fail") {
      throw new ElizaError(
        "An iMessage row has no text representable by the canonical corpus schema",
        {
          code: "CORPUS_IMESSAGE_EMPTY_TEXT_UNREPRESENTABLE",
          context: { rowId: row.rowId, attachmentCount: attachments.length },
        },
      );
    }
    return null;
  }

  accumulator.totals.attachments += attachments.length;
  accumulator.totals.attachmentBytes += attachments.reduce(
    (sum, attachment) => sum + attachment.bytes,
    0,
  );
  const shardAttachments: CorpusAttachment[] = attachments.map(
    ({ filename, mimeType, sha256: attachmentSha256 }) => ({
      filename,
      mimeType,
      sha256: attachmentSha256,
    }),
  );

  const owner = accountOwner(options);
  const senderSource = row.isFromMe
    ? options.ownerId.trim()
    : row.handle.trim();
  if (!senderSource) {
    throw new ElizaError("iMessage row is missing its sender identity", {
      code: "CORPUS_IMESSAGE_MISSING_IDENTITY",
      context: { rowId: row.rowId },
    });
  }
  const recipients = recipientsFor(row, chats, options.accountId, owner);
  if (recipients.length === 0) {
    throw new ElizaError("iMessage row has no resolvable recipients", {
      code: "CORPUS_IMESSAGE_MISSING_RECIPIENTS",
      context: { rowId: row.rowId },
    });
  }
  const senderId = row.isFromMe
    ? owner.id
    : namespaceId(options.accountId, "handle", senderSource);
  const message = corpusMessageSchema.parse({
    id: messageId,
    platform: "imessage",
    accountId: options.accountId,
    threadId: namespaceId(options.accountId, "thread", row.chatId),
    ts: row.timestamp,
    direction: row.isFromMe ? "out" : "in",
    senderId,
    senderDisplay: row.isFromMe ? owner.display : senderSource,
    recipients,
    ...(row.displayName?.trim() ? { subject: row.displayName.trim() } : {}),
    text,
    labels: row.service ? [`service:${row.service.toLowerCase()}`] : [],
    attachments: shardAttachments,
    scrubState: "raw",
  });
  accumulator.totals.includedMessages++;
  recordChatStatistics(accumulator, message, reportKey);
  return {
    message,
    ...(row.replyToGuid
      ? {
          sourceReplyId: namespaceId(
            options.accountId,
            "message",
            row.replyToGuid,
          ),
        }
      : {}),
  };
}

async function readPrivateArtifact(
  filePath: string,
  purpose: string,
): Promise<Buffer> {
  await assertNoSymlinkComponents(filePath);
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid()))
    ) {
      throw new ElizaError(`${purpose} is not a private regular file`, {
        code: "CORPUS_IMESSAGE_UNSAFE_PATH",
        context: { filePath },
      });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const published = await fs.lstat(filePath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== published.dev ||
      after.ino !== published.ino ||
      published.isSymbolicLink() ||
      BigInt(bytes.length) !== after.size
    ) {
      throw new ElizaError(`${purpose} changed while it was read`, {
        code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED",
        context: { filePath },
      });
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function iMessageIdentityIsPristine(
  outputRoot: string,
): Promise<boolean> {
  const hasIMessageShard = (await findCorpusShardFiles(outputRoot)).some(
    (shardPath) => {
      const relative = path.relative(outputRoot, shardPath);
      return relative.split(path.sep)[0] === "imessage";
    },
  );
  if (hasIMessageShard) return false;
  const reportsDirectory = path.join(outputRoot, ".reports");
  try {
    return !(await fs.readdir(reportsDirectory)).some(
      (name) => name.startsWith("imessage-") && name.endsWith(".json"),
    );
  } catch (error) {
    // error-policy:J3 A never-created reports directory is part of a pristine root.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function removePendingKeyIfSame(
  pendingPath: string,
  expected: { dev: bigint; ino: bigint },
  stateDir: string,
): Promise<void> {
  const current = await fs.lstat(pendingPath, { bigint: true });
  if (
    current.isSymbolicLink() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new ElizaError("The pending iMessage receipt key changed", {
      code: "CORPUS_IMESSAGE_REPORT_KEY_INVALID",
    });
  }
  await fs.unlink(pendingPath);
  await syncDirectory(stateDir);
}

async function privateKey(
  stateDir: string,
  outputRoot: string,
): Promise<Buffer> {
  const keyPath = path.join(stateDir, OWNER_SALT_FILE);
  try {
    const key = await readPrivateArtifact(
      keyPath,
      "The iMessage report pseudonymization key",
    );
    if (key.length !== 32) throw new Error("invalid key length");
    const keyIdentity = await fs.lstat(keyPath, { bigint: true });
    const pendingPath = `${keyPath}.pending`;
    try {
      const pendingIdentity = await fs.lstat(pendingPath, { bigint: true });
      if (
        pendingIdentity.isSymbolicLink() ||
        pendingIdentity.dev !== keyIdentity.dev ||
        pendingIdentity.ino !== keyIdentity.ino
      ) {
        throw new ElizaError(
          "The pending iMessage report key conflicts with the published key",
          { code: "CORPUS_IMESSAGE_REPORT_KEY_INVALID" },
        );
      }
      await removePendingKeyIfSame(pendingPath, pendingIdentity, stateDir);
    } catch (pendingError) {
      // error-policy:J3 No pending hardlink means key publication cleanup already completed.
      if ((pendingError as NodeJS.ErrnoException).code !== "ENOENT")
        throw pendingError;
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // error-policy:J2 A corrupt local pseudonymization key must never be silently rotated.
      throw new ElizaError(
        "Unable to read the iMessage report pseudonymization key",
        {
          code: "CORPUS_IMESSAGE_REPORT_KEY_INVALID",
          cause: error,
        },
      );
    }
    // error-policy:J3 Only a provably pristine root may establish its pseudonymization identity.
    if (!(await iMessageIdentityIsPristine(outputRoot))) {
      throw new ElizaError(
        "The iMessage report key is missing from a non-pristine corpus root",
        {
          code: "CORPUS_IMESSAGE_REPORT_KEY_INVALID",
          cause: error,
        },
      );
    }
    const pendingPath = `${keyPath}.pending`;
    try {
      const pending = await readPrivateArtifact(
        pendingPath,
        "The pending iMessage report pseudonymization key",
      );
      const pendingStat = await fs.lstat(pendingPath, { bigint: true });
      if (pending.length === 32) {
        await fs.link(pendingPath, keyPath);
        await syncDirectory(stateDir);
        await removePendingKeyIfSame(pendingPath, pendingStat, stateDir);
        return pending;
      }
      await removePendingKeyIfSame(pendingPath, pendingStat, stateDir);
    } catch (pendingError) {
      // error-policy:J3 No pending name means this pristine root has never completed key creation.
      if ((pendingError as NodeJS.ErrnoException).code !== "ENOENT")
        throw pendingError;
    }
    const key = randomBytes(32);
    const handle = await fs.open(pendingPath, "wx", 0o600);
    let pendingStat: { dev: bigint; ino: bigint };
    try {
      await syncDirectory(stateDir);
      await handle.writeFile(key);
      await handle.sync();
      const written = await handle.stat({ bigint: true });
      pendingStat = { dev: written.dev, ino: written.ino };
    } finally {
      await handle.close();
    }
    await fs.link(pendingPath, keyPath);
    await syncDirectory(stateDir);
    await removePendingKeyIfSame(pendingPath, pendingStat, stateDir);
    return key;
  }
}

async function readPrivateKey(stateDir: string): Promise<Buffer> {
  try {
    const key = await readPrivateArtifact(
      path.join(stateDir, OWNER_SALT_FILE),
      "The iMessage report pseudonymization key",
    );
    if (key.length !== 32) throw new Error("invalid key length");
    return key;
  } catch (error) {
    // error-policy:J2 Receipt verification never creates or rotates a missing/corrupt key.
    throw new ElizaError(
      "Unable to verify the iMessage collection receipt key",
      {
        code: "CORPUS_IMESSAGE_REPORT_KEY_INVALID",
        cause: error,
      },
    );
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await fs.open(directoryPath, fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function acquireCorpusLock(
  lockPath: string,
  assertRootCurrent: () => Promise<void>,
  createIfMissing = true,
) {
  const handle = await fs.open(
    lockPath,
    (createIfMissing ? fsConstants.O_CREAT : 0) |
      fsConstants.O_RDWR |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  const lockStat = await handle.stat();
  if (
    !lockStat.isFile() ||
    (lockStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && lockStat.uid !== process.getuid())
  ) {
    await handle.close();
    throw new ElizaError("The iMessage collection lock is not private", {
      code: "CORPUS_IMESSAGE_UNSAFE_PATH",
    });
  }
  try {
    await assertRootCurrent();
  } catch (error) {
    await handle.close();
    throw error;
  }
  let ffi: BunFfiModule;
  try {
    ffi = runtimeRequire("bun:ffi") as BunFfiModule;
  } catch (error) {
    await handle.close();
    // error-policy:J2 Process-lifetime advisory locking requires the Bun CLI runtime.
    throw new ElizaError("Bun FFI is required for corpus locking", {
      code: "CORPUS_IMESSAGE_LOCK_UNAVAILABLE",
      cause: error,
    });
  }
  const library = ffi.dlopen(nativeLibraryPath(), {
    flock: {
      args: [ffi.FFIType.i32, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
  }) as FlockLibrary;
  const locked = library.symbols.flock(handle.fd, 2 | 4) === 0;
  library.close();
  if (!locked) {
    await handle.close();
    throw new ElizaError(
      "Another iMessage corpus collection is already running",
      { code: "CORPUS_IMESSAGE_COLLECTION_LOCKED" },
    );
  }
  try {
    if (createIfMissing) {
      await handle.truncate(0);
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      await syncDirectory(path.dirname(lockPath));
    }
    await assertRootCurrent();
    return handle;
  } catch (error) {
    await handle.close();
    // error-policy:J2 Lock initialization preserves its filesystem cause after releasing ownership.
    throw new ElizaError("Unable to initialize the corpus collection lock", {
      code: "CORPUS_IMESSAGE_LOCK_FAILED",
      cause: error,
    });
  }
}

interface CorpusLockHandle {
  assertHeld(): void;
  close(): Promise<void>;
}

async function acquireReceiptLock(
  lockPath: string,
  assertRootCurrent: () => Promise<void>,
): Promise<CorpusLockHandle> {
  try {
    const handle = await acquireCorpusLock(lockPath, assertRootCurrent, false);
    return {
      assertHeld(): void {
        return;
      },
      async close(): Promise<void> {
        await handle.close();
      },
    };
  } catch (error) {
    // error-policy:J4 Node callers delegate the same kernel flock to the pinned Bun runtime.
    if (
      !(error instanceof ElizaError) ||
      error.code !== "CORPUS_IMESSAGE_LOCK_UNAVAILABLE"
    ) {
      throw error;
    }
  }

  const child = spawn(
    "bun",
    [
      "-e",
      `
        import { constants } from "node:fs";
        import { open } from "node:fs/promises";
        import { dlopen, FFIType } from "bun:ffi";
        const lockPath = process.env.ELIZA_CORPUS_LOCK_PATH;
        if (!lockPath) process.exit(70);
        const handle = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          await handle.close();
          process.exit(71);
        }
        const library = dlopen(
          process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
          { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
        );
        if (library.symbols.flock(handle.fd, 2 | 4) !== 0) {
          library.close();
          await handle.close();
          process.exit(73);
        }
        process.stdout.write("locked\\n");
        process.stdin.resume();
        await new Promise((resolve) => process.stdin.once("end", resolve));
        await handle.close();
        library.close();
      `,
    ],
    {
      env: { ...process.env, ELIZA_CORPUS_LOCK_PATH: lockPath },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";
  let acquired = false;
  let closing = false;
  let unexpectedExit: Error | null = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Timed out acquiring the corpus receipt lock"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes("locked\n")) return;
      acquired = true;
      finish();
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(
        new Error(
          `Corpus receipt lock process exited before acquisition: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    });
  });
  child.once("error", (error) => {
    if (!closing) unexpectedExit = error;
  });
  child.once("exit", (code, signal) => {
    if (acquired && !closing) {
      unexpectedExit = new Error(
        `Corpus receipt lock process exited unexpectedly: code=${code} signal=${signal} stderr=${stderr}`,
      );
    }
  });
  try {
    await assertRootCurrent();
  } catch (error) {
    child.stdin.end();
    throw error;
  }
  let closed = false;
  return {
    assertHeld(): void {
      if (unexpectedExit) throw unexpectedExit;
      if (!closing && child.exitCode !== null) {
        throw new Error(
          `Corpus receipt lock process is no longer running: code=${child.exitCode}`,
        );
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (unexpectedExit) throw unexpectedExit;
      closing = true;
      child.stdin.end();
      if (child.exitCode !== null) {
        if (child.exitCode !== 0) {
          throw new Error(
            `Corpus receipt lock process failed: code=${child.exitCode}`,
          );
        }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Corpus receipt lock process failed: code=${code} signal=${signal}`,
              ),
            );
        });
      });
    },
  };
}

function atomicTemporaryPath(filePath: string, rootToken: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${rootToken}.tmp`,
  );
}

async function removeClaimedAtomicTemporaryFile(
  temporary: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    // error-policy:J3 A missing fixed temporary means an earlier publication
    // completed its cleanup; every other open failure remains observable.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const held = await handle.stat({ bigint: true });
    if (
      !held.isFile() ||
      (held.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" &&
        held.uid !== BigInt(process.getuid()))
    ) {
      throw new ElizaError("An atomic corpus temporary is unsafe", {
        code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
        context: { temporary },
      });
    }
    const current = await fs.lstat(temporary, { bigint: true });
    if (
      current.isSymbolicLink() ||
      current.dev !== held.dev ||
      current.ino !== held.ino
    ) {
      throw new ElizaError("An atomic corpus temporary changed", {
        code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
        context: { temporary },
      });
    }
    await fs.rm(temporary);
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(temporary));
}

async function cleanupAtomicTemporaryArtifacts(
  outputRoot: string,
  rootToken: string,
): Promise<void> {
  await removeClaimedAtomicTemporaryFile(
    atomicTemporaryPath(path.join(outputRoot, TRANSACTION_FILE), rootToken),
  );
  await removeClaimedAtomicTemporaryFile(
    atomicTemporaryPath(path.join(outputRoot, "manifest.json"), rootToken),
  );
  const reportsDirectory = path.join(outputRoot, ".reports");
  let reportNames: string[];
  try {
    reportNames = await fs.readdir(reportsDirectory);
  } catch (error) {
    // error-policy:J3 A report directory is absent before the first successful
    // publication; other failures must not be treated as an empty directory.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await assertNoSymlinkComponents(reportsDirectory);
  await assertPrivateDirectory(reportsDirectory);
  const suffix = `.${rootToken}.tmp`;
  for (const name of reportNames) {
    if (!name.startsWith(".") || !name.endsWith(suffix)) continue;
    const artifactName = name.slice(1, -suffix.length);
    if (!/^imessage-[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(artifactName))
      continue;
    await removeClaimedAtomicTemporaryFile(path.join(reportsDirectory, name));
  }
}

async function writeAtomic(
  filePath: string,
  bytes: string,
  rootToken: string,
): Promise<void> {
  const parent = path.dirname(filePath);
  await assertNoSymlinkComponents(parent);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(parent);
  await assertPrivateDirectory(parent);
  const temporary = atomicTemporaryPath(filePath, rootToken);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (handle) {
      try {
        // error-policy:J6 The write failure remains primary after closing its private handle.
        await handle.close();
      } catch {
        // error-policy:J6 Preserve the actionable artifact publication error.
        logger.warn(
          "[CorpusTools] Failed to close a temporary artifact handle",
        );
      }
    }
    try {
      // error-policy:J6 A failed atomic publication may leave only its private temporary file.
      await fs.rm(temporary, { force: true });
    } catch {
      // error-policy:J6 Preserve the actionable publication error.
      logger.warn(
        "[CorpusTools] Failed to remove a private temporary artifact after write failure",
      );
    }
    // error-policy:J2 Artifact publication preserves its filesystem cause.
    throw new ElizaError("Unable to publish an iMessage corpus artifact", {
      code: "CORPUS_IMESSAGE_WRITE_FAILED",
      cause: error,
      context: { filePath },
    });
  }
}

async function readOptionalArtifact(filePath: string): Promise<Buffer | null> {
  try {
    return await readPrivateArtifact(filePath, "The private corpus artifact");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // error-policy:J2 Artifact snapshot reads preserve their filesystem cause.
    throw error;
  }
}

async function restoreArtifact(
  filePath: string,
  prior: Buffer | null,
  rootToken: string,
): Promise<void> {
  if (prior === null) {
    await removeDurable(filePath);
    return;
  }
  await writeAtomic(filePath, prior.toString("utf8"), rootToken);
}

async function removeDurable(filePath: string): Promise<void> {
  const durableParent = await nearestExistingDirectory(path.dirname(filePath));
  await fs.rm(filePath, { force: true });
  await syncDirectory(durableParent);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // error-policy:J2 Transaction recovery preserves unexpected filesystem failures.
    throw error;
  }
}

function assertTransactionPaths(
  outputRoot: string,
  rootToken: string,
  transaction: CorpusTransaction,
): void {
  const platformDir = path.join(outputRoot, "imessage");
  const expectedDestination = path.join(platformDir, transaction.accountId);
  const stageName = path.basename(transaction.stage);
  const backupName = path.basename(transaction.backup);
  const stageNameIsSafe =
    (stageName.startsWith(`.${transaction.accountId}.`) &&
      stageName.endsWith(".stage")) ||
    (stageName.startsWith(".") && stageName.endsWith(".removing"));
  if (
    transaction.rootToken !== rootToken ||
    transaction.destination !== expectedDestination ||
    transaction.manifestPath !== path.join(outputRoot, "manifest.json") ||
    transaction.reportPath !==
      path.join(
        outputRoot,
        ".reports",
        `imessage-${transaction.accountId}.json`,
      ) ||
    path.dirname(transaction.stage) !== platformDir ||
    !stageNameIsSafe ||
    path.dirname(transaction.backup) !== platformDir ||
    !backupName.startsWith(`.${transaction.accountId}.`) ||
    !backupName.endsWith(".backup")
  ) {
    throw new ElizaError("Corpus transaction journal contains unsafe paths", {
      code: "CORPUS_IMESSAGE_TRANSACTION_INVALID",
    });
  }
}

async function removeOwnedDirectory(
  directory: string,
  kind: "snapshot" | "generation",
  rootToken: string,
): Promise<void> {
  const inspected = await inspectOwnedDirectory(directory, kind, rootToken);
  if (inspected.status === "missing") return;
  if (inspected.status !== "owned") {
    throw new ElizaError("Refusing to remove an unowned collector directory", {
      code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
    });
  }
  const parent = path.dirname(directory);
  const alreadyQuarantined = path.basename(directory).endsWith(".removing");
  const quarantine = alreadyQuarantined
    ? directory
    : path.join(
        parent,
        `.${path.basename(directory)}.${randomUUID()}.removing`,
      );
  if (!alreadyQuarantined) {
    await fs.rename(directory, quarantine);
    await syncDirectory(parent);
  }
  const moved = await inspectOwnedDirectory(quarantine, kind, rootToken);
  if (
    moved.status !== "owned" ||
    !sameDirectoryIdentity(inspected.identity, moved.identity)
  ) {
    if (!alreadyQuarantined) {
      const quarantined = await fs.lstat(quarantine, { bigint: true });
      const quarantinedIdentity = {
        dev: quarantined.dev,
        ino: quarantined.ino,
      };
      try {
        await renameDirectoryExclusive(quarantine, directory);
        await syncDirectory(parent);
        const restored = await fs.lstat(directory, { bigint: true });
        if (
          restored.dev !== quarantinedIdentity.dev ||
          restored.ino !== quarantinedIdentity.ino
        ) {
          throw new ElizaError(
            "A mismatched collector cleanup path was not restored",
            { code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH" },
          );
        }
      } catch (error) {
        // error-policy:J2 Restoration is mandatory before surfacing a cleanup
        // race so an unowned replacement is never silently left quarantined.
        throw new ElizaError(
          "Unable to restore a directory moved during a collector cleanup race",
          {
            code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
            cause: error,
            context: { directory, quarantine },
          },
        );
      }
    }
    throw new ElizaError(
      "Collector directory identity changed before removal",
      {
        code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
        context: { directory },
      },
    );
  }
  const quarantineHandle = await fs.open(
    quarantine,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  let ffi: BunFfiModule;
  try {
    ffi = runtimeRequire("bun:ffi") as BunFfiModule;
  } catch (error) {
    await quarantineHandle.close();
    // error-policy:J2 Marker-scoped deletion requires descriptor-relative unlinkat.
    throw new ElizaError("Bun FFI is required for safe corpus cleanup", {
      code: "CORPUS_IMESSAGE_OPENAT_UNAVAILABLE",
      cause: error,
    });
  }
  const library = ffi.dlopen(nativeLibraryPath(), {
    openat: {
      args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
    unlinkat: {
      args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
    dup: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
    fdopendir: { args: [ffi.FFIType.i32], returns: ffi.FFIType.ptr },
    rewinddir: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.void },
    readdir: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.ptr },
    closedir: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    close: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
  }) as DirectoryMutationLibrary;
  const encoder = new TextEncoder();
  const encodedName = (name: string): Uint8Array => encoder.encode(`${name}\0`);
  const unlinkRelative = (name: string): void => {
    const encoded = encodedName(name);
    if (
      library.symbols.unlinkat(quarantineHandle.fd, ffi.ptr(encoded), 0) !== 0
    ) {
      throw new ElizaError(
        "Unable to unlink a collector-owned artifact safely",
        {
          code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
          context: { directory: quarantine, entry: name },
        },
      );
    }
  };
  const isDirectoryRelative = (name: string): boolean => {
    const encoded = encodedName(name);
    const fd = library.symbols.openat(
      quarantineHandle.fd,
      ffi.ptr(encoded),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    if (fd < 0) return false;
    library.symbols.close(fd);
    return true;
  };
  try {
    const held = await quarantineHandle.stat({ bigint: true });
    if (
      !held.isDirectory() ||
      held.dev !== inspected.identity.dev ||
      held.ino !== inspected.identity.ino
    ) {
      throw new ElizaError(
        "Collector directory changed before descriptor cleanup",
        {
          code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
          context: { directory },
        },
      );
    }
    const entries = readDirectoryNames(quarantineHandle.fd, ffi, library);
    for (const entry of entries) {
      if (entry === OWNED_DIRECTORY_MARKER) continue;
      if (isDirectoryRelative(entry)) {
        throw new ElizaError("Collector cleanup refuses nested directories", {
          code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
          context: { directory: quarantine, entry },
        });
      }
      unlinkRelative(entry);
    }
    const remaining = readDirectoryNames(quarantineHandle.fd, ffi, library);
    if (remaining.length !== 1 || remaining[0] !== OWNED_DIRECTORY_MARKER) {
      throw new ElizaError("Collector directory changed during cleanup", {
        code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
        context: { directory },
      });
    }
    await quarantineHandle.sync();
  } finally {
    library.close();
    await quarantineHandle.close();
  }
  // POSIX has no conditional rmdir-by-inode. The marker-only recycler is
  // intentionally retained and reused so cleanup never removes a replacement
  // path that has not been proven collector-owned through the held descriptor.
  await syncDirectory(parent);
}

async function restorePreviousGeneration(
  outputRoot: string,
  transaction: CorpusTransaction,
  assertRootCurrent: () => Promise<void>,
): Promise<void> {
  const journalPath = path.join(outputRoot, TRANSACTION_FILE);
  if (
    transaction.phase === "old-moved" ||
    transaction.phase === "new-installed"
  ) {
    await assertRootCurrent();
    const backup = await inspectOwnedDirectory(
      transaction.backup,
      "generation",
      transaction.rootToken,
    );
    if (transaction.hadDestination && backup.status !== "owned") {
      throw new ElizaError(
        "Corpus transaction backup is unavailable before rollback",
        {
          code:
            backup.status === "missing"
              ? "CORPUS_IMESSAGE_TRANSACTION_BACKUP_MISSING"
              : "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
        },
      );
    }
    if (!transaction.hadDestination && backup.status !== "missing") {
      throw new ElizaError(
        "Corpus transaction has an unexpected backup during recovery",
        { code: "CORPUS_IMESSAGE_TRANSACTION_INVALID" },
      );
    }
    // The backup is proven before clearing the installed generation. A crash
    // before the next journal write simply repeats this idempotent step.
    await removeOwnedDirectory(
      transaction.destination,
      "generation",
      transaction.rootToken,
    );
    await assertRootCurrent();
    transaction.phase = "rollback-ready";
    await writeAtomic(
      journalPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
      transaction.rootToken,
    );
  }

  if (transaction.phase === "rollback-ready") {
    await assertRootCurrent();
    const backup = await inspectOwnedDirectory(
      transaction.backup,
      "generation",
      transaction.rootToken,
    );
    const destination = await inspectOwnedDirectory(
      transaction.destination,
      "generation",
      transaction.rootToken,
    );
    if (transaction.hadDestination) {
      if (backup.status === "owned" && destination.status === "missing") {
        await fs.rename(transaction.backup, transaction.destination);
        await syncDirectory(path.dirname(transaction.destination));
      } else if (
        backup.status !== "missing" ||
        destination.status !== "owned"
      ) {
        throw new ElizaError(
          "Corpus rollback destination does not match its durable phase",
          {
            code: "CORPUS_IMESSAGE_TRANSACTION_BACKUP_MISSING",
          },
        );
      }
    } else if (
      backup.status !== "missing" ||
      destination.status !== "missing"
    ) {
      throw new ElizaError(
        "Corpus rollback without a prior generation has unexpected artifacts",
        { code: "CORPUS_IMESSAGE_TRANSACTION_INVALID" },
      );
    }
    await assertRootCurrent();
    transaction.phase = "rollback-restored";
    await writeAtomic(
      journalPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
      transaction.rootToken,
    );
  }

  if (transaction.phase !== "rollback-restored") {
    throw new ElizaError("Corpus rollback journal phase is invalid", {
      code: "CORPUS_IMESSAGE_TRANSACTION_INVALID",
    });
  }
  await assertRootCurrent();
  const restoredDestination = await inspectOwnedDirectory(
    transaction.destination,
    "generation",
    transaction.rootToken,
  );
  const remainingBackup = await inspectOwnedDirectory(
    transaction.backup,
    "generation",
    transaction.rootToken,
  );
  if (
    (transaction.hadDestination && restoredDestination.status !== "owned") ||
    (!transaction.hadDestination && restoredDestination.status !== "missing") ||
    remainingBackup.status !== "missing"
  ) {
    throw new ElizaError(
      "Corpus rollback artifacts do not match the restored journal phase",
      { code: "CORPUS_IMESSAGE_TRANSACTION_INVALID" },
    );
  }
  await restoreArtifact(
    transaction.manifestPath,
    transaction.priorManifestBase64 === null
      ? null
      : Buffer.from(transaction.priorManifestBase64, "base64"),
    transaction.rootToken,
  );
  await assertRootCurrent();
  await restoreArtifact(
    transaction.reportPath,
    transaction.priorReportBase64 === null
      ? null
      : Buffer.from(transaction.priorReportBase64, "base64"),
    transaction.rootToken,
  );
}

async function finalizeCommittedTransaction(
  outputRoot: string,
  transaction: CorpusTransaction,
  assertRootCurrent: () => Promise<void>,
): Promise<void> {
  await assertRootCurrent();
  const destination = await inspectOwnedDirectory(
    transaction.destination,
    "generation",
    transaction.rootToken,
  );
  if (destination.status !== "owned") {
    throw new ElizaError("Committed corpus destination ownership is invalid", {
      code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
    });
  }
  const backup = await inspectOwnedDirectory(
    transaction.backup,
    "generation",
    transaction.rootToken,
  );
  if (
    (transaction.hadDestination && backup.status === "invalid") ||
    (!transaction.hadDestination && backup.status !== "missing")
  ) {
    throw new ElizaError(
      "Committed corpus backup state does not match its journal",
      { code: "CORPUS_IMESSAGE_TRANSACTION_BACKUP_MISSING" },
    );
  }
  const candidate = await buildPublishCandidate(outputRoot);
  await assertRootCurrent();
  if (candidate.issues.length > 0) {
    throw new ElizaError(
      "Committed corpus shards are invalid; retaining the previous generation",
      {
        code: "CORPUS_IMESSAGE_COMMITTED_GENERATION_INVALID",
        context: {
          issueCount: candidate.issues.length,
          firstIssue: JSON.stringify(candidate.issues[0]),
        },
      },
    );
  }
  let manifest: CorpusManifest;
  let report: IMessageCollectionReport;
  try {
    manifest = receiptManifestSchema.parse(
      JSON.parse(
        (
          await readPrivateArtifact(
            transaction.manifestPath,
            "The committed iMessage corpus manifest",
          )
        ).toString("utf8"),
      ),
    );
    report = collectionReportSchema.parse(
      JSON.parse(
        (
          await readPrivateArtifact(
            transaction.reportPath,
            "The committed iMessage collection report",
          )
        ).toString("utf8"),
      ),
    );
  } catch (error) {
    // error-policy:J2 Committed-artifact parsing preserves corruption details while retaining the backup.
    throw new ElizaError(
      "Committed corpus artifacts are invalid; retaining the previous generation",
      {
        code: "CORPUS_IMESSAGE_COMMITTED_GENERATION_INVALID",
        cause: error,
      },
    );
  }
  if (
    manifestContent(manifest) !== manifestContent(candidate.manifest) ||
    report.accountId !== transaction.accountId
  ) {
    throw new ElizaError(
      "Committed corpus artifacts do not match the installed generation",
      { code: "CORPUS_IMESSAGE_COMMITTED_GENERATION_INVALID" },
    );
  }
  const reportKey = await readPrivateKey(
    path.join(outputRoot, STATE_DIRECTORY),
  );
  assertCollectionReceiptBinding(
    report,
    manifest,
    reportKey,
    attachmentTotalsForAccount(
      candidate.accountAttachmentTotals,
      "imessage",
      transaction.accountId,
    ),
  );
  const finalDestination = await inspectOwnedDirectory(
    transaction.destination,
    "generation",
    transaction.rootToken,
  );
  if (
    finalDestination.status !== "owned" ||
    !sameDirectoryIdentity(destination.identity, finalDestination.identity)
  ) {
    throw new ElizaError(
      "Committed corpus destination changed during recovery",
      { code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED" },
    );
  }
  if (transaction.hadDestination && backup.status === "owned") {
    await assertRootCurrent();
    await removeOwnedDirectory(
      transaction.backup,
      "generation",
      transaction.rootToken,
    );
  }
}

async function recoverCorpusTransaction(
  outputRoot: string,
  rootToken: string,
  assertRootCurrent: () => Promise<void>,
): Promise<void> {
  await assertRootCurrent();
  const journalPath = path.join(outputRoot, TRANSACTION_FILE);
  const raw = await readOptionalArtifact(journalPath);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    // error-policy:J3 A malformed private journal is explicit invalid state, never ignored.
    throw new ElizaError("Corpus transaction journal is malformed", {
      code: "CORPUS_IMESSAGE_TRANSACTION_INVALID",
      cause: error,
    });
  }
  const transaction = corpusTransactionSchema.parse(parsed);
  assertTransactionPaths(outputRoot, rootToken, transaction);

  if (transaction.phase === "manifest-committed") {
    await assertRootCurrent();
    await finalizeCommittedTransaction(
      outputRoot,
      transaction,
      assertRootCurrent,
    );
  } else if (transaction.phase === "prepared") {
    const backupExists = await pathExists(transaction.backup);
    const destinationExists = await pathExists(transaction.destination);
    if (backupExists && !transaction.hadDestination) {
      throw new ElizaError(
        "Corpus transaction has an unexpected backup before install",
        { code: "CORPUS_IMESSAGE_TRANSACTION_INVALID" },
      );
    }
    if (transaction.hadDestination && !backupExists && !destinationExists) {
      throw new ElizaError(
        "Corpus transaction lost both its destination and backup",
        { code: "CORPUS_IMESSAGE_TRANSACTION_BACKUP_MISSING" },
      );
    }
    if (!transaction.hadDestination && destinationExists) {
      throw new ElizaError(
        "Corpus transaction has an unexpected destination before install",
        { code: "CORPUS_IMESSAGE_TRANSACTION_INVALID" },
      );
    }
    if (
      transaction.hadDestination &&
      destinationExists &&
      !backupExists &&
      !(await hasOwnedDirectoryMarker(
        transaction.destination,
        "generation",
        rootToken,
      ))
    ) {
      throw new ElizaError(
        "Corpus prepared transaction destination ownership is invalid",
        { code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH" },
      );
    }
    if (backupExists) {
      if (destinationExists) {
        throw new ElizaError(
          "Corpus transaction has both destination and backup before install",
          {
            code: "CORPUS_IMESSAGE_TRANSACTION_INVALID",
          },
        );
      }
      if (
        !(await hasOwnedDirectoryMarker(
          transaction.backup,
          "generation",
          rootToken,
        ))
      ) {
        throw new ElizaError("Corpus transaction backup ownership is invalid", {
          code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
        });
      }
      await assertRootCurrent();
      await fs.rename(transaction.backup, transaction.destination);
      await syncDirectory(path.dirname(transaction.destination));
    }
    await assertRootCurrent();
    await restoreArtifact(
      transaction.manifestPath,
      transaction.priorManifestBase64 === null
        ? null
        : Buffer.from(transaction.priorManifestBase64, "base64"),
      rootToken,
    );
    await assertRootCurrent();
    await restoreArtifact(
      transaction.reportPath,
      transaction.priorReportBase64 === null
        ? null
        : Buffer.from(transaction.priorReportBase64, "base64"),
      rootToken,
    );
  } else {
    await assertRootCurrent();
    await restorePreviousGeneration(outputRoot, transaction, assertRootCurrent);
  }
  await assertRootCurrent();
  await removeOwnedDirectory(transaction.stage, "generation", rootToken);
  await removeDurable(journalPath);
}

async function cleanupOwnedOrphans(
  parent: string,
  nameMatches: (name: string) => boolean,
  kind: "snapshot" | "generation",
  rootToken: string,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // error-policy:J2 Orphan inspection preserves unexpected filesystem failures.
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !nameMatches(entry.name)) continue;
    const candidate = path.join(parent, entry.name);
    const inspected = await inspectOwnedDirectory(candidate, kind, rootToken);
    if (inspected.status === "owned") {
      await removeOwnedDirectory(candidate, kind, rootToken);
    }
  }
}

async function createOrReuseOwnedDirectory(
  parent: string,
  target: string,
  kind: "snapshot" | "generation",
  rootToken: string,
): Promise<string> {
  if (!path.basename(target).includes(rootToken)) {
    throw new ElizaError("A collector allocation is not token-bound", {
      code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
      context: { target },
    });
  }
  const targetInspection = await inspectOwnedDirectory(target, kind, rootToken);
  if (targetInspection.status === "owned") {
    const names = await fs.readdir(target);
    const current = await inspectOwnedDirectory(target, kind, rootToken);
    if (
      current.status !== "owned" ||
      !sameDirectoryIdentity(targetInspection.identity, current.identity)
    ) {
      throw new ElizaError("A collector allocation changed during recovery", {
        code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
        context: { target },
      });
    }
    if (names.length === 1 && names[0] === OWNED_DIRECTORY_MARKER) {
      return target;
    }
    await removeOwnedDirectory(target, kind, rootToken);
  } else if (targetInspection.status === "invalid") {
    await assertPrivateDirectory(target);
    const names = await fs.readdir(target);
    if (names.length === 1 && names[0] === OWNED_DIRECTORY_MARKER) {
      await assertPrivateRegularFile(path.join(target, OWNED_DIRECTORY_MARKER));
      await fs.rm(path.join(target, OWNED_DIRECTORY_MARKER));
      await syncDirectory(target);
    } else if (names.length !== 0) {
      throw new ElizaError(
        "A markerless collector allocation contains unowned artifacts",
        {
          code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
          context: { target },
        },
      );
    }
    await writeOwnedDirectoryMarker(target, kind, rootToken);
    return target;
  }

  const entries = await fs.readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".removing")) continue;
    const recycler = path.join(parent, entry.name);
    const inspected = await inspectOwnedDirectory(recycler, kind, rootToken);
    if (inspected.status !== "owned") continue;
    await removeOwnedDirectory(recycler, kind, rootToken);
    const reused = await inspectOwnedDirectory(recycler, kind, rootToken);
    if (
      reused.status !== "owned" ||
      !sameDirectoryIdentity(inspected.identity, reused.identity)
    ) {
      throw new ElizaError("Collector recycler changed during allocation", {
        code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
      });
    }
    return recycler;
  }
  await fs.mkdir(target, { mode: 0o700 });
  await writeOwnedDirectoryMarker(target, kind, rootToken);
  return target;
}

async function cleanupOrphanGenerations(
  outputRoot: string,
  rootToken: string,
): Promise<void> {
  const platformDir = path.join(outputRoot, "imessage");
  await cleanupOwnedOrphans(
    platformDir,
    (name) => name.startsWith(".") && name.endsWith(".stage"),
    "generation",
    rootToken,
  );
  await cleanupOwnedOrphans(
    platformDir,
    (name) => name.startsWith(".") && name.endsWith(".backup"),
    "generation",
    rootToken,
  );
  await cleanupOwnedOrphans(
    platformDir,
    (name) => name.startsWith(".") && name.endsWith(".removing"),
    "generation",
    rootToken,
  );
}

interface StreamingCorpusIssue {
  path?: string;
  line?: number;
  code:
    | "schema-invalid"
    | "cutoff-window"
    | "duplicate-id"
    | "reply-missing"
    | "path-mismatch"
    | "manifest-invalid"
    | "manifest-mismatch"
    | "empty-shard";
  message: string;
}

interface ShardPathIdentity {
  relative: string;
  platform?: CorpusPlatform;
  accountId?: string;
  month?: string;
}

interface AccountAttachmentTotals {
  count: number;
  messageIds: Set<string>;
}

function shardPathIdentity(
  rootDir: string,
  shardPath: string,
): ShardPathIdentity {
  const relativePath = path.relative(rootDir, shardPath);
  const relative = relativePath.split(path.sep).join("/");
  const parts = relativePath.split(path.sep);
  if (
    parts.length !== 3 ||
    !corpusPlatforms.includes(parts[0] as CorpusPlatform) ||
    !/^\d{4}-\d{2}\.jsonl$/.test(parts[2] ?? "")
  ) {
    return { relative };
  }
  return {
    relative,
    platform: parts[0] as CorpusPlatform,
    accountId: parts[1],
    month: parts[2]?.slice(0, -".jsonl".length),
  };
}

async function streamCorpusShard(
  rootDir: string,
  shardPath: string,
  globalIds: Set<string>,
): Promise<{
  sha256: string;
  count: number;
  firstTs: number | undefined;
  lastTs: number | undefined;
  attachmentCount: number;
  messageIds: Set<string>;
  issues: StreamingCorpusIssue[];
}> {
  const issues: StreamingCorpusIssue[] = [];
  const identity = shardPathIdentity(rootDir, shardPath);
  const ids = new Set<string>();
  const replies: Array<{ id: string; replyToId: string }> = [];
  await assertNoSymlinkComponents(shardPath);
  const handle = await fs.open(
    shardPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ElizaError("Corpus shards must be regular files", {
        code: "CORPUS_IMESSAGE_UNSAFE_PATH",
        context: { shardPath },
      });
    }
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let pending = "";
    let position = 0;
    let lineNumber = 0;
    let count = 0;
    let firstTs: number | undefined;
    let lastTs: number | undefined;
    let attachmentCount = 0;

    const inspectLine = (rawLine: string): void => {
      lineNumber++;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // error-policy:J3 Corpus rows are untrusted input and retain an explicit invalid-line result.
        issues.push({
          path: shardPath,
          line: lineNumber,
          code: "schema-invalid",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const validated = corpusMessageSchema.safeParse(parsed);
      if (!validated.success) {
        issues.push({
          path: shardPath,
          line: lineNumber,
          code: "schema-invalid",
          message: validated.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
        return;
      }
      const message = validated.data;
      count++;
      attachmentCount += message.attachments.length;
      firstTs =
        firstTs === undefined ? message.ts : Math.min(firstTs, message.ts);
      lastTs = lastTs === undefined ? message.ts : Math.max(lastTs, message.ts);
      if (message.ts > CORPUS_ANCHOR_MS) {
        issues.push({
          path: shardPath,
          line: lineNumber,
          code: "cutoff-window",
          message: `message ${message.id} is after corpus anchor`,
        });
      }
      if (ids.has(message.id) || globalIds.has(message.id)) {
        issues.push({
          path: shardPath,
          line: lineNumber,
          code: "duplicate-id",
          message: `duplicate message id ${message.id}`,
        });
      }
      ids.add(message.id);
      globalIds.add(message.id);
      if (message.replyToId) {
        replies.push({ id: message.id, replyToId: message.replyToId });
      }
      if (
        message.platform !== identity.platform ||
        message.accountId !== identity.accountId ||
        new Date(message.ts).toISOString().slice(0, 7) !== identity.month
      ) {
        issues.push({
          path: shardPath,
          line: lineNumber,
          code: "path-mismatch",
          message: `message ${message.id} does not match shard path ${identity.relative}`,
        });
      }
    };

    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      position += bytesRead;
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        inspectLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending) inspectLine(pending);
    if (count === 0) {
      issues.push({
        path: shardPath,
        code: "empty-shard",
        message: "shard contains no valid JSONL rows",
      });
    }
    for (const reply of replies) {
      if (!ids.has(reply.replyToId)) {
        issues.push({
          path: shardPath,
          code: "reply-missing",
          message: `message ${reply.id} replies to missing ${reply.replyToId}`,
        });
      }
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new ElizaError("Corpus shard changed during validation", {
        code: "CORPUS_IMESSAGE_SHARD_CHANGED",
        context: { shardPath },
      });
    }
    return {
      sha256: hash.digest("hex"),
      count,
      firstTs,
      lastTs,
      attachmentCount,
      messageIds: ids,
      issues,
    };
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 Streaming validation retains decoding and filesystem causes.
    throw new ElizaError("Unable to stream a corpus shard", {
      code: "CORPUS_IMESSAGE_SHARD_READ_FAILED",
      cause: error,
      context: { shardPath },
    });
  } finally {
    await handle.close();
  }
}

async function buildStreamingCorpusManifest(
  outputRoot: string,
  generatedAt = new Date().toISOString(),
): Promise<{
  manifest: CorpusManifest;
  issues: StreamingCorpusIssue[];
  accountAttachmentTotals: Map<string, AccountAttachmentTotals>;
}> {
  const shardFiles = await findCorpusShardFiles(outputRoot);
  const issues: StreamingCorpusIssue[] = [];
  const shards: CorpusManifest["shards"] = [];
  const globalIds = new Set<string>();
  const accountAttachmentTotals = new Map<string, AccountAttachmentTotals>();
  for (const shardPath of shardFiles) {
    const relative = path.relative(outputRoot, shardPath);
    const components = relative.split(path.sep).filter(Boolean);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new ElizaError(
        "Corpus shard discovery escaped the private corpus root",
        { code: "CORPUS_IMESSAGE_UNSAFE_PATH" },
      );
    }
    // Private journals, snapshots, backups, and stages are never canonical
    // <platform>/<account>/<month>.jsonl paths.
    if (components.some((component) => component.startsWith("."))) continue;
    const pathIdentity = shardPathIdentity(outputRoot, shardPath);
    const streamed = await streamCorpusShard(outputRoot, shardPath, globalIds);
    issues.push(...streamed.issues);
    if (
      !pathIdentity.platform ||
      !pathIdentity.accountId ||
      !pathIdentity.month
    ) {
      issues.push({
        path: shardPath,
        code: "path-mismatch",
        message: "shard path must be <platform>/<account>/<yyyy-mm>.jsonl",
      });
      continue;
    }
    if (
      streamed.count === 0 ||
      streamed.firstTs === undefined ||
      streamed.lastTs === undefined
    ) {
      continue;
    }
    const attachmentKey = `${pathIdentity.platform}\0${pathIdentity.accountId}`;
    const attachmentTotals = accountAttachmentTotals.get(attachmentKey) ?? {
      count: 0,
      messageIds: new Set<string>(),
    };
    attachmentTotals.count += streamed.attachmentCount;
    for (const messageId of streamed.messageIds) {
      attachmentTotals.messageIds.add(messageId);
    }
    accountAttachmentTotals.set(attachmentKey, attachmentTotals);
    shards.push({
      path: pathIdentity.relative,
      platform: pathIdentity.platform,
      accountId: pathIdentity.accountId,
      month: pathIdentity.month,
      count: streamed.count,
      firstTs: streamed.firstTs,
      lastTs: streamed.lastTs,
      sha256: streamed.sha256,
    });
  }
  const manifest = corpusManifestSchema.parse({
    schemaVersion: 1,
    generatedAt,
    cutoffIso: CORPUS_CUTOFF_ISO,
    shards,
    totals: {
      messages: shards.reduce((sum, shard) => sum + shard.count, 0),
      contacts: 0,
      threads: 0,
    },
  });
  return { manifest, issues, accountAttachmentTotals };
}

function manifestContent(manifest: CorpusManifest): string {
  const { generatedAt: _generatedAt, ...stable } = manifest;
  return JSON.stringify(stable);
}

async function validateStreamingCorpusTarget(outputRoot: string): Promise<{
  ok: boolean;
  manifest: CorpusManifest;
  issues: StreamingCorpusIssue[];
  accountAttachmentTotals: Map<string, AccountAttachmentTotals>;
}> {
  const manifestPath = path.join(outputRoot, "manifest.json");
  let expected: CorpusManifest | null = null;
  const manifestIssues: StreamingCorpusIssue[] = [];
  try {
    expected = receiptManifestSchema.parse(
      JSON.parse(
        (
          await readPrivateArtifact(
            manifestPath,
            "The iMessage corpus manifest",
          )
        ).toString("utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // error-policy:J3 Invalid manifest bytes become an explicit validation issue.
      manifestIssues.push({
        path: manifestPath,
        code: "manifest-invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // `generatedAt` is volatile global metadata shared by every corpus
  // publisher. The iMessage receipt binds all stable manifest fields and exact
  // account shard hashes without invalidating untouched accounts when another
  // publisher refreshes that timestamp.
  const built = await buildStreamingCorpusManifest(outputRoot);
  const issues = [...built.issues, ...manifestIssues];
  let hasIMessageReport = false;
  try {
    hasIMessageReport = (
      await fs.readdir(path.join(outputRoot, ".reports"))
    ).some((name) => name.startsWith("imessage-") && name.endsWith(".json"));
  } catch (error) {
    // error-policy:J3 A missing reports directory has no bound iMessage receipts.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !expected &&
    manifestIssues.length === 0 &&
    (built.manifest.shards.length > 0 || hasIMessageReport)
  ) {
    issues.push({
      path: manifestPath,
      code: "manifest-invalid",
      message: "manifest.json is missing from a non-empty corpus",
    });
  }
  if (
    expected &&
    manifestContent(expected) !== manifestContent(built.manifest)
  ) {
    issues.push({
      path: manifestPath,
      code: "manifest-mismatch",
      message: "manifest.json does not match shard contents",
    });
  }
  return {
    ok: issues.length === 0,
    manifest: built.manifest,
    issues,
    accountAttachmentTotals: built.accountAttachmentTotals,
  };
}

async function buildPublishCandidate(outputRoot: string) {
  return await buildStreamingCorpusManifest(outputRoot);
}

function attachmentTotalsForAccount(
  totals: ReadonlyMap<string, AccountAttachmentTotals>,
  platform: CorpusPlatform,
  accountId: string,
): AccountAttachmentTotals {
  const current = totals.get(`${platform}\0${accountId}`);
  if (current) return current;
  return { count: 0, messageIds: new Set<string>() };
}

async function createGenerationStage(
  outputRoot: string,
  accountId: string,
  rootToken: string,
): Promise<string> {
  const platformDir = path.join(outputRoot, "imessage");
  try {
    await fs.mkdir(platformDir, { mode: 0o700 });
  } catch (error) {
    // error-policy:J3 EEXIST selects validation of the collector-owned platform directory.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPrivateDirectory(platformDir);
  const stage = path.join(platformDir, `.${accountId}.${rootToken}.stage`);
  return await createOrReuseOwnedDirectory(
    platformDir,
    stage,
    "generation",
    rootToken,
  );
}

async function materializeStageFromSpool(
  spoolPath: string,
  stage: string,
  publishedMonths: ReadonlyMap<string, string>,
  accumulator: CollectionAccumulator,
): Promise<void> {
  const handles = new Map<string, Awaited<ReturnType<typeof fs.open>>>();
  try {
    const lines = createInterface({
      input: createReadStream(spoolPath, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // error-policy:J3 The private spool is an explicit invalid artifact after parse failure.
        throw new ElizaError("The iMessage collection spool is malformed", {
          code: "CORPUS_IMESSAGE_SPOOL_INVALID",
          cause: error,
        });
      }
      const record = spoolRecordSchema.parse(parsed);
      const base = record.message;
      const month = new Date(base.ts).toISOString().slice(0, 7);
      let replyToId: string | undefined;
      if (record.sourceReplyId) {
        if (publishedMonths.get(record.sourceReplyId) === month)
          replyToId = record.sourceReplyId;
        else accumulator.totals.externalReplies++;
      }
      const message = corpusMessageSchema.parse({
        ...base,
        ...(replyToId ? { replyToId } : {}),
      });
      let handle = handles.get(month);
      if (!handle) {
        handle = await fs.open(path.join(stage, `${month}.jsonl`), "wx", 0o600);
        handles.set(month, handle);
      }
      await handle.writeFile(`${JSON.stringify(message)}\n`);
    }
    for (const handle of handles.values()) await handle.sync();
  } finally {
    for (const handle of handles.values()) {
      try {
        // error-policy:J6 Spool materialization closes every private shard handle during teardown.
        await handle.close();
      } catch {
        // error-policy:J6 The primary materialization result remains observable.
        logger.warn(
          "[CorpusTools] Failed to close an iMessage shard staging handle",
        );
      }
    }
  }
  await syncDirectory(stage);
}

async function publishPreparedShards<T>(
  stage: string,
  outputRoot: string,
  accountId: string,
  rootToken: string,
  priorManifest: Buffer | null,
  reportPath: string,
  priorReport: Buffer | null,
  assertRootCurrent: () => Promise<void>,
  verifyAndPublishManifest: () => Promise<T>,
): Promise<T> {
  await assertRootCurrent();
  const platformDir = path.join(outputRoot, "imessage");
  const destination = path.join(platformDir, accountId);
  if (!(await hasOwnedDirectoryMarker(stage, "generation", rootToken))) {
    throw new ElizaError("The iMessage shard stage is not collector-owned", {
      code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
    });
  }
  const backup = path.join(platformDir, `.${accountId}.${rootToken}.backup`);
  const journalPath = path.join(outputRoot, TRANSACTION_FILE);
  const transaction: CorpusTransaction = {
    schemaVersion: 1,
    rootToken,
    accountId,
    phase: "prepared",
    destination,
    backup,
    stage,
    manifestPath: path.join(outputRoot, "manifest.json"),
    reportPath,
    hadDestination: await pathExists(destination),
    priorManifestBase64: priorManifest?.toString("base64") ?? null,
    priorReportBase64: priorReport?.toString("base64") ?? null,
  };
  if (
    transaction.hadDestination &&
    !(await hasOwnedDirectoryMarker(destination, "generation", rootToken))
  ) {
    throw new ElizaError(
      "The existing iMessage account generation is not collector-owned",
      {
        code: "CORPUS_IMESSAGE_OWNERSHIP_MISMATCH",
      },
    );
  }
  let committed = false;
  let result: T | undefined;
  try {
    await assertRootCurrent();
    await writeAtomic(
      journalPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
      rootToken,
    );
    await assertRootCurrent();
    if (transaction.hadDestination) {
      await fs.rename(destination, backup);
      await syncDirectory(platformDir);
      await syncDirectory(path.dirname(backup));
    }
    await assertRootCurrent();
    transaction.phase = "old-moved";
    await writeAtomic(
      journalPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
      rootToken,
    );
    await assertRootCurrent();
    await fs.rename(stage, destination);
    await syncDirectory(platformDir);
    await assertRootCurrent();
    transaction.phase = "new-installed";
    await writeAtomic(
      journalPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
      rootToken,
    );
    await assertRootCurrent();
    result = await verifyAndPublishManifest();
    await assertRootCurrent();
    transaction.phase = "manifest-committed";
    await writeAtomic(
      journalPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
      rootToken,
    );
    await assertRootCurrent();
    committed = true;
  } catch (error) {
    try {
      // error-policy:J6 Durable journal recovery restores the prior generation before returning failure.
      await assertRootCurrent();
      if (await pathExists(journalPath)) {
        await recoverCorpusTransaction(
          outputRoot,
          rootToken,
          assertRootCurrent,
        );
      } else {
        await removeOwnedDirectory(stage, "generation", rootToken);
      }
    } catch (rollbackError) {
      // error-policy:J2 Recovery failure preserves the original publication failure in context.
      throw new ElizaError(
        "Unable to recover the corpus publication transaction",
        {
          code: "CORPUS_IMESSAGE_TRANSACTION_RECOVERY_FAILED",
          cause: rollbackError,
          context: {
            publicationError:
              error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    // error-policy:J2 Account publication preserves its atomic-swap cause.
    throw new ElizaError(
      "Unable to atomically publish iMessage corpus shards",
      {
        code: "CORPUS_IMESSAGE_PUBLISH_FAILED",
        cause: error,
      },
    );
  } finally {
    if (transaction.hadDestination && committed) {
      try {
        // error-policy:J6 The new shard directory is already published and fully validated in memory.
        await assertRootCurrent();
        await removeOwnedDirectory(backup, "generation", rootToken);
      } catch {
        // error-policy:J6 A private backup is safer than risking deletion of the published directory.
        logger.warn(
          "[CorpusTools] Failed to remove the previous private iMessage shard directory",
        );
      }
    }
    if (committed) {
      try {
        // error-policy:J6 A committed journal is retained only if durable cleanup fails.
        await assertRootCurrent();
        await removeOwnedDirectory(stage, "generation", rootToken);
        await removeDurable(journalPath);
      } catch {
        // error-policy:J6 The next locked collector run finalizes a committed journal.
        logger.warn(
          "[CorpusTools] Deferred cleanup of a committed corpus transaction",
        );
      }
    }
  }
  if (!committed || result === undefined) {
    throw new ElizaError(
      "iMessage shard publication completed without a manifest result",
      {
        code: "CORPUS_IMESSAGE_PUBLISH_INCOMPLETE",
      },
    );
  }
  return result;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function collectionManifestBinding(
  manifest: CorpusManifest,
  accountId: string,
): string {
  return sha256(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      cutoffIso: manifest.cutoffIso,
      shards: manifest.shards.filter(
        (entry) =>
          entry.platform === "imessage" && entry.accountId === accountId,
      ),
    }),
  );
}

function reportPayload(
  report: IMessageCollectionReport,
): Omit<IMessageCollectionReport, "receiptHmac"> {
  const { receiptHmac: _receiptHmac, ...payload } = report;
  return payload;
}

function signCollectionReport(
  report: Omit<IMessageCollectionReport, "receiptHmac">,
  reportKey: Buffer,
): string {
  return createHmac("sha256", reportKey)
    .update("imessage-collection-receipt-v2")
    .update("\0")
    .update(JSON.stringify(report))
    .digest("hex");
}

function buildCollectionReport(
  options: CollectIMessageOptions,
  accumulator: CollectionAccumulator,
  snapshot: ChatDbSnapshot,
  throughRowId: number,
  sinceMs: number,
  untilMs: number,
  manifest: CorpusManifest,
  reportKey: Buffer,
): IMessageCollectionReport {
  const shardEntries = manifest.shards.filter(
    (entry) =>
      entry.platform === "imessage" && entry.accountId === options.accountId,
  );
  const unsigned: Omit<IMessageCollectionReport, "receiptHmac"> = {
    schemaVersion: 2,
    platform: "imessage",
    accountId: options.accountId,
    sourceSnapshot: {
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      throughRowId,
    },
    window: { sinceMs, untilMs },
    unavailableAttachmentPolicy: options.unavailableAttachmentPolicy ?? "fail",
    totals: accumulator.totals,
    byChat: [...accumulator.byChat.values()].sort((left, right) =>
      left.chatIdHash.localeCompare(right.chatIdHash),
    ),
    shardSha256: shardEntries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      count: entry.count,
    })),
    unavailableAttachments: [...accumulator.unavailableAttachments].sort(
      (left, right) =>
        left.messageIdHash.localeCompare(right.messageIdHash) ||
        left.attachmentIdHash.localeCompare(right.attachmentIdHash),
    ),
    omittedMessages: [...accumulator.omittedMessages].sort((left, right) =>
      left.messageIdHash.localeCompare(right.messageIdHash),
    ),
    accountManifestSha256: collectionManifestBinding(
      manifest,
      options.accountId,
    ),
  };
  return {
    ...unsigned,
    receiptHmac: signCollectionReport(unsigned, reportKey),
  };
}

function assertCollectionReceiptBinding(
  report: IMessageCollectionReport,
  manifest: CorpusManifest,
  reportKey: Buffer,
  attachmentTotals: AccountAttachmentTotals,
): void {
  const includedMessageHashes = new Set(
    [...attachmentTotals.messageIds].map((messageId) =>
      receiptIdentifier(reportKey, "message", messageId),
    ),
  );
  const omittedMessageHashes = new Set(
    report.omittedMessages.map((message) => message.messageIdHash),
  );
  if (
    report.accountManifestSha256 !==
    collectionManifestBinding(manifest, report.accountId)
  ) {
    throw new ElizaError(
      "The iMessage collection receipt does not bind the current manifest",
      { code: "CORPUS_IMESSAGE_RECEIPT_MANIFEST_MISMATCH" },
    );
  }
  if (
    report.totals.unavailableAttachments !==
      report.unavailableAttachments.length ||
    report.totals.omittedMessages !== report.omittedMessages.length ||
    report.totals.sourceRows !==
      report.totals.includedMessages +
        report.totals.excludedReactions +
        report.totals.excludedSystem +
        report.totals.excludedOther +
        report.totals.omittedMessages ||
    report.totals.includedMessages !==
      report.byChat.reduce((sum, chat) => sum + chat.count, 0) ||
    report.totals.attachments !==
      report.byChat.reduce((sum, chat) => sum + chat.attachmentCount, 0) ||
    report.byChat.some(
      (chat) => chat.count === 0 || chat.count !== chat.inCount + chat.outCount,
    ) ||
    new Set(report.byChat.map((chat) => chat.chatIdHash)).size !==
      report.byChat.length ||
    new Set(
      report.unavailableAttachments.map(
        (attachment) =>
          `${attachment.messageIdHash}\0${attachment.attachmentIdHash}`,
      ),
    ).size !== report.unavailableAttachments.length ||
    new Set(report.omittedMessages.map((message) => message.messageIdHash))
      .size !== report.omittedMessages.length ||
    [...omittedMessageHashes].some((hash) => includedMessageHashes.has(hash)) ||
    report.unavailableAttachments.some(
      (attachment) =>
        !includedMessageHashes.has(attachment.messageIdHash) &&
        !omittedMessageHashes.has(attachment.messageIdHash),
    ) ||
    (report.unavailableAttachmentPolicy === "fail" &&
      (report.unavailableAttachments.length > 0 ||
        report.omittedMessages.length > 0))
  ) {
    throw new ElizaError("The iMessage collection receipt totals are invalid", {
      code: "CORPUS_IMESSAGE_RECEIPT_INVALID",
    });
  }
  const expectedShards = manifest.shards
    .filter(
      (entry) =>
        entry.platform === "imessage" && entry.accountId === report.accountId,
    )
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      count: entry.count,
    }));
  const expectedMessages = expectedShards.reduce(
    (sum, shard) => sum + shard.count,
    0,
  );
  if (
    report.totals.includedMessages !== expectedMessages ||
    report.totals.attachments !== attachmentTotals.count
  ) {
    throw new ElizaError(
      "The iMessage collection receipt totals do not match published shards",
      { code: "CORPUS_IMESSAGE_RECEIPT_TOTALS_MISMATCH" },
    );
  }
  if (JSON.stringify(report.shardSha256) !== JSON.stringify(expectedShards)) {
    throw new ElizaError(
      "The iMessage collection receipt does not match the account shards",
      { code: "CORPUS_IMESSAGE_RECEIPT_SHARD_MISMATCH" },
    );
  }
  const expected = signCollectionReport(reportPayload(report), reportKey);
  const actualBytes = Buffer.from(report.receiptHmac, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new ElizaError("The iMessage collection receipt HMAC is invalid", {
      code: "CORPUS_IMESSAGE_RECEIPT_HMAC_INVALID",
    });
  }
}

async function ensureStateDirectory(outputRoot: string): Promise<string> {
  const stateDir = path.join(outputRoot, STATE_DIRECTORY);
  try {
    await fs.mkdir(stateDir, { mode: 0o700 });
  } catch (error) {
    // error-policy:J3 EEXIST selects validation of the private state directory.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPrivateDirectory(stateDir);
  const canonical = await fs.realpath(stateDir);
  assertPathHasNoControlCharacters(canonical, "canonical state directory");
  return canonical;
}

export async function verifyIMessageCollectionReceipt(
  outputRoot: string,
  accountId: string,
): Promise<IMessageCollectionReport> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(accountId)) {
    throw new ElizaError("iMessage corpus accountId must be a path-safe slug", {
      code: "CORPUS_IMESSAGE_INVALID_ACCOUNT",
    });
  }
  assertPathHasNoControlCharacters(outputRoot, "private root");
  const privateRoot = path.resolve(outputRoot);
  assertPathHasNoControlCharacters(privateRoot, "resolved private root");
  await assertPrivateRootIsGitIgnored(privateRoot);
  await assertNoSymlinkComponents(privateRoot);
  await assertPrivateDirectory(privateRoot);
  const canonicalRoot = await fs.realpath(privateRoot);
  assertPathHasNoControlCharacters(canonicalRoot, "canonical private root");
  const marker = await readRootMarker(canonicalRoot);
  const requestedStateDir = path.join(canonicalRoot, STATE_DIRECTORY);
  await assertNoSymlinkComponents(requestedStateDir);
  await assertPrivateDirectory(requestedStateDir);
  const stateDir = await fs.realpath(requestedStateDir);
  assertPathHasNoControlCharacters(stateDir, "canonical state directory");
  await assertPrivateDirectory(stateDir);
  const rootIdentity = await directoryIdentity(canonicalRoot);
  const stateIdentity = await directoryIdentity(stateDir);
  const assertRootCurrent = async (): Promise<void> => {
    await assertDirectoryUnchanged(canonicalRoot, rootIdentity);
    await assertDirectoryUnchanged(stateDir, stateIdentity);
    const currentMarker = await readRootMarker(canonicalRoot);
    if (currentMarker.token !== marker.token) {
      throw new ElizaError(
        "iMessage corpus ownership changed during receipt verification",
        { code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED" },
      );
    }
  };
  let lockHandle: CorpusLockHandle;
  try {
    lockHandle = await acquireReceiptLock(
      path.join(canonicalRoot, ".corpus-collection.lock"),
      assertRootCurrent,
    );
  } catch (error) {
    // error-policy:J2 Receipt verification must share the collector's kernel lock namespace.
    throw new ElizaError("Unable to lock the iMessage collection receipt", {
      code: "CORPUS_IMESSAGE_RECEIPT_LOCK_FAILED",
      cause: error,
    });
  }
  try {
    await assertRootCurrent();
    if (await pathExists(path.join(canonicalRoot, TRANSACTION_FILE))) {
      throw new ElizaError(
        "The iMessage collection receipt has an unfinished transaction",
        { code: "CORPUS_IMESSAGE_RECEIPT_TRANSACTION_PENDING" },
      );
    }
    const reportKey = await readPrivateKey(stateDir);
    const reportPath = path.join(
      canonicalRoot,
      ".reports",
      `imessage-${accountId}.json`,
    );
    let report: IMessageCollectionReport;
    try {
      report = collectionReportSchema.parse(
        JSON.parse(
          (
            await readPrivateArtifact(
              reportPath,
              "The iMessage collection receipt",
            )
          ).toString("utf8"),
        ),
      );
    } catch (error) {
      // error-policy:J2 Receipt parsing preserves the invalid local artifact cause.
      throw new ElizaError("Unable to parse the iMessage collection receipt", {
        code: "CORPUS_IMESSAGE_RECEIPT_INVALID",
        cause: error,
      });
    }
    if (report.accountId !== accountId) {
      throw new ElizaError(
        "The iMessage collection receipt account is invalid",
        { code: "CORPUS_IMESSAGE_RECEIPT_INVALID" },
      );
    }
    const validation = await validateStreamingCorpusTarget(canonicalRoot);
    if (!validation.ok) {
      throw new ElizaError(
        "The iMessage collection receipt refers to an invalid current corpus",
        {
          code: "CORPUS_IMESSAGE_RECEIPT_CORPUS_INVALID",
          context: {
            issueCount: validation.issues.length,
            firstIssue: JSON.stringify(validation.issues[0]),
          },
        },
      );
    }
    assertCollectionReceiptBinding(
      report,
      validation.manifest,
      reportKey,
      attachmentTotalsForAccount(
        validation.accountAttachmentTotals,
        "imessage",
        accountId,
      ),
    );
    lockHandle.assertHeld();
    await assertRootCurrent();
    lockHandle.assertHeld();
    return report;
  } finally {
    await lockHandle.close();
  }
}

export async function collectIMessageCorpus(
  options: CollectIMessageOptions,
): Promise<IMessageCollectionResult> {
  const { sinceMs, untilMs, pageSize } = validateOptions(options);
  const runtime = options.runtime ?? (await loadRuntime());
  const requestedDbPath = options.dbPath ?? runtime.defaultDbPath;
  const requestedAttachmentRoot =
    options.attachmentRoot ?? "~/Library/Messages/Attachments";
  assertPathHasNoControlCharacters(requestedDbPath, "database path");
  assertPathHasNoControlCharacters(requestedAttachmentRoot, "attachment root");

  const ownedRoot = await ensureOwnedPrivateRoot(options.outputRoot);
  const outputRoot = ownedRoot.root;
  const stateDir = await ensureStateDirectory(outputRoot);
  const resolvedDbPath = path.resolve(expandHome(requestedDbPath));
  assertPathHasNoControlCharacters(resolvedDbPath, "resolved database path");
  const dbPath = await fs.realpath(resolvedDbPath);
  assertPathHasNoControlCharacters(dbPath, "canonical database path");
  const attachmentRoot = path.resolve(expandHome(requestedAttachmentRoot));
  assertPathHasNoControlCharacters(attachmentRoot, "resolved attachment root");
  await assertSeparatedPaths(outputRoot, dbPath);
  await assertNoSymlinkComponents(attachmentRoot);
  const attachmentRootIdentity = await directoryIdentity(attachmentRoot);
  const outputIdentity = await directoryIdentity(outputRoot);
  const stateIdentity = await directoryIdentity(stateDir);
  const assertRootCurrent = async (): Promise<void> => {
    await assertDirectoryUnchanged(outputRoot, outputIdentity);
    await assertDirectoryUnchanged(stateDir, stateIdentity);
    const marker = await readRootMarker(outputRoot);
    if (marker.token !== ownedRoot.marker.token) {
      throw new ElizaError(
        "iMessage corpus ownership changed during collection",
        { code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED" },
      );
    }
  };
  const lockHandle = await acquireCorpusLock(
    path.join(outputRoot, ".corpus-collection.lock"),
    assertRootCurrent,
  );

  try {
    await assertRootCurrent();
    await cleanupAtomicTemporaryArtifacts(outputRoot, ownedRoot.marker.token);
    await assertRootCurrent();
    await recoverCorpusTransaction(
      outputRoot,
      ownedRoot.marker.token,
      assertRootCurrent,
    );
    await assertRootCurrent();
    await cleanupOrphanGenerations(outputRoot, ownedRoot.marker.token);
    await cleanupOwnedOrphans(
      stateDir,
      (name) =>
        name.startsWith("imessage-snapshot-") ||
        name.startsWith("imessage-validation-") ||
        (name.startsWith(".") && name.endsWith(".removing")),
      "snapshot",
      ownedRoot.marker.token,
    );
    await assertRootCurrent();

    const existing = await validateStreamingCorpusTarget(outputRoot);
    if (!existing.ok) {
      throw new ElizaError(
        "Existing corpus output is invalid; refusing to replace one account",
        {
          code: "CORPUS_IMESSAGE_EXISTING_OUTPUT_INVALID",
          context: { issueCount: existing.issues.length },
        },
      );
    }

    let snapshotDir = path.join(
      stateDir,
      `.imessage-snapshot.${ownedRoot.marker.token}.allocating`,
    );
    await assertRootCurrent();
    snapshotDir = await createOrReuseOwnedDirectory(
      stateDir,
      snapshotDir,
      "snapshot",
      ownedRoot.marker.token,
    );
    await assertRootCurrent();
    let stage: string | null = null;
    try {
      const snapshotPath = path.join(snapshotDir, "chat.db");
      const spoolPath = path.join(snapshotDir, SPOOL_FILE);
      const snapshot = await runtime.snapshot(dbPath, snapshotPath);
      const reportKey = await privateKey(stateDir, outputRoot);
      const accumulator = createAccumulator();
      const publishedMonths = new Map<string, string>();
      const reader = await runtime.openReader(snapshotPath);
      if (!reader) {
        throw new ElizaError(
          "The consistent iMessage snapshot could not be opened",
          { code: "CORPUS_IMESSAGE_SNAPSHOT_OPEN_FAILED" },
        );
      }
      const throughRowId = await (async (): Promise<number> => {
        try {
          const chats = new Map(
            reader.listChatsStrict().map((chat) => [chat.chatId, chat]),
          );
          const through = reader.getLatestRowIdStrict();
          const spoolHandle = await fs.open(spoolPath, "wx", 0o600);
          let spoolClosed = false;
          try {
            let cursor = 0;
            while (cursor < through) {
              const page = reader.pageMessages({
                sinceMs,
                untilMs,
                afterRowId: cursor,
                throughRowId: through,
                limit: pageSize,
              });
              if (page.length === 0) break;
              for (const row of page) {
                const record = await mapMessageToSpool(
                  row,
                  chats,
                  options,
                  attachmentRoot,
                  attachmentRootIdentity,
                  reportKey,
                  accumulator,
                );
                if (!record) continue;
                if (publishedMonths.has(record.message.id)) {
                  throw new ElizaError(
                    "iMessage history contains a duplicate account-scoped message id",
                    {
                      code: "CORPUS_IMESSAGE_DUPLICATE_ID",
                      context: { rowId: row.rowId },
                    },
                  );
                }
                publishedMonths.set(
                  record.message.id,
                  new Date(record.message.ts).toISOString().slice(0, 7),
                );
                await spoolHandle.writeFile(`${JSON.stringify(record)}\n`);
              }
              const next = page.at(-1)?.rowId;
              if (!next || next <= cursor) {
                throw new ElizaError(
                  "iMessage reader failed to advance its ROWID cursor",
                  {
                    code: "CORPUS_IMESSAGE_CURSOR_STALLED",
                    context: { cursor, throughRowId: through },
                  },
                );
              }
              cursor = next;
            }
            await spoolHandle.sync();
            await spoolHandle.close();
            spoolClosed = true;
          } finally {
            if (!spoolClosed) {
              try {
                // error-policy:J6 The primary collection failure remains observable after spool teardown.
                await spoolHandle.close();
              } catch {
                // error-policy:J6 Process teardown also closes the private spool descriptor.
                logger.warn(
                  "[CorpusTools] Failed to close the iMessage collection spool",
                );
              }
            }
          }
          return through;
        } finally {
          reader.close();
        }
      })();

      await assertRootCurrent();
      stage = await createGenerationStage(
        outputRoot,
        options.accountId,
        ownedRoot.marker.token,
      );
      await materializeStageFromSpool(
        spoolPath,
        stage,
        publishedMonths,
        accumulator,
      );
      await assertRootCurrent();

      const manifestPath = path.join(outputRoot, "manifest.json");
      const reportPath = path.join(
        outputRoot,
        ".reports",
        `imessage-${options.accountId}.json`,
      );
      const priorManifest = await readOptionalArtifact(manifestPath);
      const priorReport = await readOptionalArtifact(reportPath);
      const transaction = await publishPreparedShards(
        stage,
        outputRoot,
        options.accountId,
        ownedRoot.marker.token,
        priorManifest,
        reportPath,
        priorReport,
        assertRootCurrent,
        async () => {
          await assertRootCurrent();
          const candidate = await buildPublishCandidate(outputRoot);
          if (candidate.issues.length > 0) {
            throw new ElizaError(
              "Published iMessage shards failed corpus validation",
              {
                code: "CORPUS_IMESSAGE_VALIDATION_FAILED",
                context: {
                  issueCount: candidate.issues.length,
                  firstIssue: JSON.stringify(candidate.issues[0]),
                },
              },
            );
          }
          const manifestBytes = `${JSON.stringify(candidate.manifest, null, 2)}\n`;
          const report = buildCollectionReport(
            options,
            accumulator,
            snapshot,
            throughRowId,
            sinceMs,
            untilMs,
            candidate.manifest,
            reportKey,
          );
          const validatedReport = collectionReportSchema.parse(report);
          await writeAtomic(
            reportPath,
            `${JSON.stringify(validatedReport, null, 2)}\n`,
            ownedRoot.marker.token,
          );
          await writeAtomic(
            manifestPath,
            manifestBytes,
            ownedRoot.marker.token,
          );
          assertCollectionReceiptBinding(
            validatedReport,
            candidate.manifest,
            reportKey,
            attachmentTotalsForAccount(
              candidate.accountAttachmentTotals,
              "imessage",
              options.accountId,
            ),
          );
          await assertRootCurrent();
          return { manifestResult: candidate, report: validatedReport };
        },
      );
      await assertRootCurrent();
      stage = null;
      return {
        report: transaction.report,
        manifest: transaction.manifestResult.manifest,
        reportPath,
        manifestPath,
      };
    } finally {
      if (stage) {
        try {
          // error-policy:J6 Only a marker-bound private generation stage is eligible for teardown.
          await assertRootCurrent();
          await removeOwnedDirectory(
            stage,
            "generation",
            ownedRoot.marker.token,
          );
        } catch {
          // error-policy:J6 The primary collection result remains observable; the next locked run retries cleanup.
          logger.warn(
            "[CorpusTools] Deferred cleanup of an iMessage generation stage",
          );
        }
      }
      try {
        // error-policy:J6 The marker-bound snapshot is private ephemeral input after success or failure.
        await assertRootCurrent();
        await removeOwnedDirectory(
          snapshotDir,
          "snapshot",
          ownedRoot.marker.token,
        );
      } catch {
        // error-policy:J6 Collection success/failure is already observable; teardown must not replace it.
        logger.warn(
          "[CorpusTools] Failed to remove the private iMessage database snapshot",
        );
      }
    }
  } finally {
    try {
      // error-policy:J6 Closing the descriptor releases the kernel-owned advisory lock.
      await lockHandle.close();
    } catch {
      // error-policy:J6 Process exit also releases the advisory lock if descriptor close fails.
      logger.warn(
        "[CorpusTools] Failed to close the iMessage collection lock handle",
      );
    }
  }
}
