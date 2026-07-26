export const MAX_CHAT_IMAGES = 4;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 60 * 1024 * 1024;
export const CHAT_UPLOAD_ACCEPT = "image/*";
export function bytesToMb(bytes) {
  return Math.round(bytes / (1024 * 1024));
}
export function perFileByteCap() {
  return MAX_ATTACHMENT_BYTES;
}
export function partitionAttachmentFiles(files) {
  return { accepted: Array.from(files), droppedTooLarge: [], droppedOverCount: [] };
}
export async function filesToImageAttachments() {
  return [];
}
