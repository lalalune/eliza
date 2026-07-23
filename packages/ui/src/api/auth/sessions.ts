/**
 * Client-side auth constants (session/CSRF cookie + header names) shared with
 * the node auth implementation in @elizaos/app-core.
 */
export const SESSION_COOKIE_NAME = "eliza_session";
export const CSRF_COOKIE_NAME = "eliza_csrf";
export const CSRF_HEADER_NAME = "x-eliza-csrf";

/**
 * Reads the current CSRF token from the browser's readable double-submit
 * cookie. Keeping this beside the shared names lets both the generic API client
 * and the fetch helper apply exactly the same session mutation contract.
 */
export function readCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${CSRF_COOKIE_NAME}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}
