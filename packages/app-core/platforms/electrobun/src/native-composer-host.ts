/**
 * Owns the Electrobun side of the native-composer bridge. OS-delivered deep
 * links become idempotent composer operations, including byte-backed local
 * files, while renderer events are retained as the shell's latest mirror.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_IMAGE_MIME_TYPE_SET,
  CHAT_UPLOAD_MIME_TYPE_SET,
  MAX_CHAT_IMAGE_RAW_BYTES,
  MAX_CHAT_MEDIA_RAW_BYTES,
  MAX_CHAT_UPLOAD_ATTACHMENTS,
} from "@elizaos/shared/chat-upload-limits";

export const NATIVE_COMPOSER_SCHEMA = "eliza.native-composer/v1" as const;

export interface NativeComposerOperationStream {
  schema: typeof NATIVE_COMPOSER_SCHEMA;
  operations: unknown[];
}

export interface NativeComposerRendererEventInput {
  schema: string;
  event: unknown;
}

const operationQueue: unknown[] = [];
const latestRendererEvents = new Map<string, unknown>();
const COMPOSER_EVENT_TYPES = new Set([
  "draft.changed",
  "send.result",
  "focus.changed",
  "voice.state",
]);

const CHAT_ROUTES = new Set([
  "ask",
  "assistant",
  "chat",
  "chat/ask",
  "chat/smart-reply",
  "chat/voice",
  "share",
  "smart-reply",
  "voice",
]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function deepLinkPath(parsed: URL): string {
  return `${parsed.host}/${parsed.pathname}`.replace(/^\/+|\/+$/g, "");
}

function launchText(params: URLSearchParams): string {
  for (const key of ["text", "q", "query", "body"] as const) {
    const value = params.get(key)?.trim();
    if (value) return value;
  }
  return "";
}

function resolveLocalFile(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("native composer file path is empty");
  const resolved = value.startsWith("file:") ? fileURLToPath(value) : value;
  if (!path.isAbsolute(resolved)) {
    throw new Error("native composer accepts only absolute OS-delivered files");
  }
  return resolved;
}

function inlineAttachmentOperation(
  rawPath: string,
  launchId: string,
  index: number,
): unknown {
  const filePath = resolveLocalFile(rawPath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`native composer attachment is not a file: ${filePath}`);
  }
  const mimeType = MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (!mimeType || !CHAT_UPLOAD_MIME_TYPE_SET.has(mimeType)) {
    throw new Error(
      `native composer attachment type is unsupported: ${filePath}`,
    );
  }
  const byteCap = CHAT_IMAGE_MIME_TYPE_SET.has(mimeType)
    ? MAX_CHAT_IMAGE_RAW_BYTES
    : MAX_CHAT_MEDIA_RAW_BYTES;
  if (stat.size === 0 || stat.size > byteCap) {
    throw new Error(
      `native composer attachment size ${stat.size} exceeds ${byteCap}: ${filePath}`,
    );
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength !== stat.size) {
    throw new Error(
      `native composer attachment changed while reading: ${filePath}`,
    );
  }
  return {
    type: "attachment.add",
    opId: `${launchId}:attachment:${index}`,
    attachmentId: `${launchId}:attachment:${index}`,
    attachment: {
      source: "inline",
      mimeType,
      bytesBase64: bytes.toString("base64"),
      name: path.basename(filePath),
    },
  };
}

/** Convert a supported OS deep link into reviewable composer operations. */
export function nativeComposerOperationsFromDeepLink(url: string): unknown[] {
  const parsed = new URL(url);
  const route = deepLinkPath(parsed).toLowerCase();
  if (!CHAT_ROUTES.has(route)) return [];

  const launchId =
    parsed.searchParams.get("assistant.launchId")?.trim() || randomUUID();
  const operations: unknown[] = [];
  const text = launchText(parsed.searchParams);
  if (text) {
    operations.push({
      type: "text.set",
      opId: `${launchId}:text`,
      text,
    });
  }
  const files = parsed.searchParams.getAll("file");
  if (files.length > MAX_CHAT_UPLOAD_ATTACHMENTS) {
    throw new Error(
      `native composer accepts at most ${MAX_CHAT_UPLOAD_ATTACHMENTS} attachments`,
    );
  }
  for (const [index, file] of files.entries()) {
    operations.push(inlineAttachmentOperation(file, launchId, index));
  }
  if (route === "voice" || route === "chat/voice") {
    operations.push({
      type: "voice.handoff",
      opId: `${launchId}:voice`,
      phase: "start",
    });
  }
  if (operations.length > 0) {
    operations.push({
      type: "focus.set",
      opId: `${launchId}:focus`,
      focused: true,
      keyboard: "shown",
    });
  }
  // OS-authored text is attacker-controlled. Only a trusted native command
  // surface may append `send`; deep links always stop at a reviewable draft.
  return operations;
}

/** Queue an operation stream for cold-start drain and return its wire envelope. */
export function enqueueNativeComposerOperations(
  operations: readonly unknown[],
): NativeComposerOperationStream {
  operationQueue.push(...operations);
  return { schema: NATIVE_COMPOSER_SCHEMA, operations: [...operations] };
}

/** Atomically drain operations that arrived before the renderer subscribed. */
export function drainNativeComposerOperations(): NativeComposerOperationStream {
  return {
    schema: NATIVE_COMPOSER_SCHEMA,
    operations: operationQueue.splice(0),
  };
}

/** Validate and retain the renderer's latest event of each discriminant. */
export function publishNativeComposerEvent(
  input: NativeComposerRendererEventInput,
): { ok: true } {
  if (input.schema !== NATIVE_COMPOSER_SCHEMA) {
    throw new Error(`unsupported native composer schema: ${input.schema}`);
  }
  if (!input.event || typeof input.event !== "object") {
    throw new Error("native composer event must be an object");
  }
  const type = (input.event as { type?: unknown }).type;
  if (typeof type !== "string" || !COMPOSER_EVENT_TYPES.has(type)) {
    throw new Error("native composer event type is unsupported");
  }
  latestRendererEvents.set(type, structuredClone(input.event));
  return { ok: true };
}

export function readLatestNativeComposerEvent(type: string): unknown {
  const event = latestRendererEvents.get(type);
  return event === undefined ? undefined : structuredClone(event);
}

export function resetNativeComposerHostForTests(): void {
  operationQueue.splice(0);
  latestRendererEvents.clear();
}
