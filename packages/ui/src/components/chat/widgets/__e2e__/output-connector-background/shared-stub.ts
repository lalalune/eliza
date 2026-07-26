export const DEFAULT_DESKTOP_API_PORT = 2138;
export const CHAT_IMAGE_MIME_TYPE_SET = new Set(["image/png", "image/jpeg", "image/webp"]);
export const CHAT_UPLOAD_MIME_TYPE_SET = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_CHAT_ATTACHMENT_NAME_LENGTH = 160;
export const MAX_CHAT_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
export const MAX_CHAT_MEDIA_RAW_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_UPLOAD_ATTACHMENTS = 4;
export const ENV_KEY_ACRONYMS = new Set(["API", "URL", "ID"]);
export function autoLabel(key) {
  return String(key ?? "")
    .replace(/^[A-Z0-9]+_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
export function stripAssistantStageDirections(text) {
  return text;
}
export function isPermissionId(value) {
  return typeof value === "string" && value.length > 0;
}
export function openPermissionSettings() {
  return false;
}
