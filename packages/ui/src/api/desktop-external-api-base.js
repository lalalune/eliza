/**
 * Reads the desktop-injected external API base origin from the window global and
 * validates it as an http(s) origin. Used to route the client at an external
 * agent when the desktop host points it there.
 */
function getWindowExternalApiBase() {
    if (typeof window === "undefined")
        return null;
    return window
        .__ELIZA_DESKTOP_EXTERNAL_API_BASE__;
}
export function getDesktopExternalApiBaseOrigin() {
    const value = getWindowExternalApiBase();
    if (typeof value !== "string" || !value.trim())
        return null;
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:"
            ? parsed.origin
            : null;
    }
    catch {
        // error-policy:J3 unparseable injected base — no external API origin is
        // trusted (fail-closed).
        return null;
    }
}
export function isDesktopExternalApiBaseUrl(url) {
    const allowedOrigin = getDesktopExternalApiBaseOrigin();
    if (!allowedOrigin)
        return false;
    try {
        return new URL(url).origin === allowedOrigin;
    }
    catch {
        // error-policy:J3 unparseable URL never matches the allowed origin
        // (fail-closed).
        return false;
    }
}
export function isDesktopExternalHttpApiBaseUrl(url) {
    const allowedOrigin = getDesktopExternalApiBaseOrigin();
    if (!allowedOrigin)
        return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" && parsed.origin === allowedOrigin;
    }
    catch {
        // error-policy:J3 unparseable URL never matches the allowed origin
        // (fail-closed).
        return false;
    }
}
