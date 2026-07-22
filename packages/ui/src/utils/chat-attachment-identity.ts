/**
 * Renderer-only identity for pending chat attachments. New attachments receive
 * unique ids at intake; deterministic content ids keep older/programmatic
 * values stable until the composer writes the explicit field back.
 */

import type { ImageAttachment } from "../api/client-types-chat";

let attachmentIdentitySequence = 0;

/** Mint an identity that survives list insertion and removal. */
export function createChatAttachmentClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `attachment-${uuid}`;
  attachmentIdentitySequence += 1;
  return `attachment-${Date.now().toString(36)}-${attachmentIdentitySequence.toString(36)}`;
}

/** Stable identity for old/programmatic attachments that predate the id field. */
export function chatAttachmentClientIdentity(
  attachment: ImageAttachment,
): string {
  if (attachment.clientAttachmentId) return attachment.clientAttachmentId;
  // Legacy values can hold multi-megabyte base64 payloads and this helper runs
  // during render. A bounded content sample keeps fallback reconciliation
  // deterministic without scanning the entire upload on every React pass.
  const middle = Math.floor(attachment.data.length / 2);
  const input = [
    attachment.mimeType,
    attachment.name,
    String(attachment.data.length),
    attachment.data.slice(0, 128),
    attachment.data.slice(Math.max(0, middle - 64), middle + 64),
    attachment.data.slice(-128),
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `legacy-${(hash >>> 0).toString(16)}-${attachment.data.length}`;
}
