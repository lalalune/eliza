function ttsDebugEnabled() {
    const truthy = (raw) => {
        if (raw == null)
            return false;
        const v = String(raw).trim().toLowerCase();
        return v === "1" || v === "true" || v === "yes" || v === "on";
    };
    if (typeof process !== "undefined" && process.env) {
        if (truthy(process.env.ELIZA_TTS_DEBUG))
            return true;
    }
    try {
        const viteEnv = import.meta.env;
        if (truthy(String(viteEnv?.ELIZA_TTS_DEBUG ?? "")))
            return true;
        if (truthy(String(viteEnv?.VITE_ELIZA_TTS_DEBUG ?? "")))
            return true;
    }
    catch {
        /* no import.meta */
    }
    return false;
}
/** Same predicate as `ttsDebug` — use to attach optional debug headers / task metadata. */
export function isTtsDebugEnabled() {
    return ttsDebugEnabled();
}
const DEFAULT_PREVIEW_MAX = 160;
/**
 * Single-line preview of text for TTS debug logs (avoids huge console lines).
 * Enable `ELIZA_TTS_DEBUG` only when you accept that spoken lines may appear in logs.
 */
export function ttsDebugTextPreview(text, maxChars = DEFAULT_PREVIEW_MAX) {
    const singleLine = text.replace(/\r?\n/g, "↵ ").replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxChars)
        return singleLine;
    return `${singleLine.slice(0, maxChars)}…`;
}
export function ttsDebug(phase, detail) {
    if (!ttsDebugEnabled())
        return;
    if (detail && Object.keys(detail).length > 0) {
        console.info(`[eliza][tts] ${phase}`, detail);
    }
    else {
        console.info(`[eliza][tts] ${phase}`);
    }
}
