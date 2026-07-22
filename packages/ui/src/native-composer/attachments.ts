/**
 * Normalizes a decoded {@link ComposerAttachmentSource} into a
 * {@link ComposerAttachment} expressed purely in the existing content-addressed
 * media store's vocabulary — a `data:` URL, a remote http(s) URL flagged for
 * server-side SSRF-guarded ingest, or an already-stored `/api/media/<hash>` URL.
 *
 * This is the "route attachments through the existing store, add no second store"
 * seam on the renderer side: it produces no file id and no bespoke handle, only a
 * URL a send adapter can materialize through the authenticated media boundary.
 * This normalizer does not itself persist or fetch bytes. Oversized or malformed
 * bytes are rejected with a typed reason (never a fabricated attachment), so a
 * bad source stops here instead of becoming a broken tile downstream.
 *
 * The private-host check on `remote` is a fast first-line guard for obvious
 * loopback/RFC-1918 literals; it is NOT the authority. The server's DNS-pinned
 * SSRF guard (`packages/core/src/network`, driven by `fetchRemoteMedia`) makes the
 * binding decision at rehost time.
 */

import {
  CHAT_IMAGE_MIME_TYPE_SET,
  CHAT_UPLOAD_MIME_TYPE_SET,
  MAX_CHAT_ATTACHMENT_NAME_LENGTH,
  MAX_CHAT_IMAGE_RAW_BYTES,
  MAX_CHAT_MEDIA_RAW_BYTES,
} from "@elizaos/shared/chat-upload-limits";
import type {
  ComposerAttachment,
  ComposerAttachmentSource,
  ComposerRejectReason,
} from "./contract";

/** Default hard cap on inline attachment bytes; mirrors the chat API cap. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = MAX_CHAT_MEDIA_RAW_BYTES;

/** Served-media URL prefix; a `stored` source must already point here. */
const STORED_MEDIA_PREFIX = "/api/media/";
/** `<sha256>.<ext>` — the store's content-addressed file name shape. */
const STORED_MEDIA_NAME = /^[a-f0-9]{64}\.[a-z0-9]+$/i;

export interface NormalizeAttachmentOptions {
  /** Reject inline/data-url bytes larger than this (default chat media cap). */
  maxBytes?: number;
}

export type NormalizeAttachmentResult =
  | { ok: true; attachment: ComposerAttachment }
  | { ok: false; reason: ComposerRejectReason; message: string };

function reject(
  reason: ComposerRejectReason,
  message: string,
): { ok: false; reason: ComposerRejectReason; message: string } {
  return { ok: false, reason, message };
}

/** A mime is well-formed iff it is `type/subtype` with non-empty halves. */
function isWellFormedMime(mime: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mime);
}

interface CanonicalBase64 {
  payload: string;
  byteLength: number;
}

/** Validate loose base64 and add the padding browsers require for data URLs. */
function canonicalizeBase64(base64: string): CanonicalBase64 | null {
  const cleaned = base64.replace(/\s+/g, "");
  if (cleaned.length === 0) return { payload: "", byteLength: 0 };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  const core = cleaned.replace(/=+$/, "");
  const remainder = core.length % 4;
  // A base64 payload can omit padding, but one sextet cannot encode a byte.
  if (remainder === 1) return null;
  const requiredPadding = remainder === 0 ? 0 : 4 - remainder;
  const suppliedPadding = cleaned.length - core.length;
  if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) return null;
  return {
    payload: core + "=".repeat(requiredPadding),
    byteLength: Math.floor((core.length * 6) / 8),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    encoded +=
      second === undefined
        ? "="
        : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? "=" : alphabet[third & 0x3f];
  }
  return encoded;
}

/**
 * True for a hostname that is a loopback or RFC-1918/link-local literal, or has
 * no dot (bare host / `.local`) — the obvious SSRF footguns worth rejecting
 * before a round-trip. Authoritative blocking is the server's DNS-pinned guard.
 */
function isObviouslyPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  if (host.endsWith(".local") || !host.includes(".")) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"))
    return true;
  return false;
}

function validateUploadMetadata(
  mimeType: string,
  name: string | undefined,
): NormalizeAttachmentResult | null {
  if (!isWellFormedMime(mimeType))
    return reject("invalid-input", `malformed mime: ${mimeType}`);
  if (!CHAT_UPLOAD_MIME_TYPE_SET.has(mimeType.toLowerCase()))
    return reject("unsupported", `unsupported attachment type: ${mimeType}`);
  if (name !== undefined && name.length > MAX_CHAT_ATTACHMENT_NAME_LENGTH) {
    return reject(
      "invalid-input",
      `attachment name exceeds ${MAX_CHAT_ATTACHMENT_NAME_LENGTH} characters`,
    );
  }
  return null;
}

function uploadByteCap(mimeType: string, requestedCap: number): number {
  const endpointCap = CHAT_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase())
    ? MAX_CHAT_IMAGE_RAW_BYTES
    : MAX_CHAT_MEDIA_RAW_BYTES;
  return Math.min(requestedCap, endpointCap);
}

interface CanonicalDataUrl {
  mimeType: string;
  url: string;
  byteLength: number;
}

/** Convert every accepted data URL form into one preview-safe base64 form. */
function canonicalizeDataUrl(dataUrl: string): CanonicalDataUrl | null {
  if (!dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice("data:".length, comma);
  const headerParts = header.split(";").map((part) => part.trim());
  const mimeType = headerParts[0]?.toLowerCase();
  if (!mimeType) return null;
  const payload = dataUrl.slice(comma + 1);
  if (headerParts.slice(1).some((part) => part.toLowerCase() === "base64")) {
    const canonical = canonicalizeBase64(payload);
    if (!canonical) return null;
    return {
      mimeType,
      url: `data:${mimeType};base64,${canonical.payload}`,
      byteLength: canonical.byteLength,
    };
  }
  try {
    const bytes = new TextEncoder().encode(decodeURIComponent(payload));
    return {
      mimeType,
      url: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
      byteLength: bytes.byteLength,
    };
  } catch {
    // error-policy:J3 untrusted-input sanitizing — malformed percent escapes
    // are an explicit invalid data URL, never accepted for later persistence.
    return null;
  }
}

/**
 * Normalize one attachment source into the media-store vocabulary, or reject it
 * with a typed reason. The decoder has already validated field shapes; this adds
 * the semantic checks the store cares about: a well-formed mime and a byte cap.
 */
export function normalizeComposerAttachment(
  id: string,
  source: ComposerAttachmentSource,
  options: NormalizeAttachmentOptions = {},
): NormalizeAttachmentResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  switch (source.source) {
    case "inline": {
      const metadataError = validateUploadMetadata(
        source.mimeType,
        source.name,
      );
      if (metadataError) return metadataError;
      const canonical = canonicalizeBase64(source.bytesBase64);
      if (!canonical)
        return reject("invalid-input", "attachment bytes are not valid base64");
      if (canonical.byteLength === 0)
        return reject("invalid-input", "attachment has no bytes");
      const byteCap = uploadByteCap(source.mimeType, maxBytes);
      if (canonical.byteLength > byteCap)
        return reject(
          "oversized",
          `attachment ${canonical.byteLength}B exceeds cap ${byteCap}B`,
        );
      const mimeType = source.mimeType.toLowerCase();
      return {
        ok: true,
        attachment: {
          id,
          url: `data:${mimeType};base64,${canonical.payload}`,
          mimeType,
          ...(source.name ? { name: source.name } : {}),
          kind: "inline",
          status: "ready",
        },
      };
    }
    case "data-url": {
      const canonical = canonicalizeDataUrl(source.dataUrl);
      if (!canonical)
        return reject("invalid-input", "data URL has no valid mediatype");
      const metadataError = validateUploadMetadata(
        canonical.mimeType,
        source.name,
      );
      if (metadataError) return metadataError;
      if (canonical.byteLength === 0)
        return reject("invalid-input", "data URL has no bytes");
      const byteCap = uploadByteCap(canonical.mimeType, maxBytes);
      if (canonical.byteLength > byteCap)
        return reject(
          "oversized",
          `attachment ${canonical.byteLength}B exceeds cap ${byteCap}B`,
        );
      return {
        ok: true,
        attachment: {
          id,
          url: canonical.url,
          mimeType: canonical.mimeType,
          ...(source.name ? { name: source.name } : {}),
          kind: "inline",
          status: "ready",
        },
      };
    }
    case "remote": {
      if (source.mimeType) {
        const metadataError = validateUploadMetadata(
          source.mimeType,
          source.name,
        );
        if (metadataError) return metadataError;
      } else if (
        source.name !== undefined &&
        source.name.length > MAX_CHAT_ATTACHMENT_NAME_LENGTH
      ) {
        return reject("invalid-input", "attachment name is too long");
      }
      let parsed: URL;
      try {
        parsed = new URL(source.url);
      } catch {
        // error-policy:J3 untrusted-input sanitizing — an unparseable native URL
        // is an explicit typed "invalid" result, not a fabricated attachment.
        return reject("invalid-input", `not a valid URL: ${source.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return reject("unsupported", `unsupported scheme: ${parsed.protocol}`);
      if (isObviouslyPrivateHost(parsed.hostname))
        return reject(
          "permission-denied",
          `blocked private host: ${parsed.hostname}`,
        );
      return {
        ok: true,
        attachment: {
          id,
          url: source.url,
          ...(source.mimeType ? { mimeType: source.mimeType } : {}),
          ...(source.name ? { name: source.name } : {}),
          kind: "remote",
          // Awaits the server's SSRF-guarded ingest; not yet in the store.
          status: "pending-rehost",
        },
      };
    }
    case "stored": {
      if (source.mimeType) {
        const metadataError = validateUploadMetadata(
          source.mimeType,
          source.name,
        );
        if (metadataError) return metadataError;
      } else if (
        source.name !== undefined &&
        source.name.length > MAX_CHAT_ATTACHMENT_NAME_LENGTH
      ) {
        return reject("invalid-input", "attachment name is too long");
      }
      const name = source.url.startsWith(STORED_MEDIA_PREFIX)
        ? source.url.slice(STORED_MEDIA_PREFIX.length).split(/[?#]/)[0]
        : "";
      if (!name || !STORED_MEDIA_NAME.test(name))
        return reject("invalid-input", `not a stored media URL: ${source.url}`);
      return {
        ok: true,
        attachment: {
          id,
          url: source.url,
          ...(source.mimeType ? { mimeType: source.mimeType } : {}),
          ...(source.name ? { name: source.name } : {}),
          kind: "stored",
          status: "ready",
        },
      };
    }
  }
}
