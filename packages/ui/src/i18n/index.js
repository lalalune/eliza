/**
 * Barrel for i18n: message catalogs, translator factory, region helpers, and
 * re-exported language-code primitives owned by @elizaos/shared.
 */
import { normalizeLanguage } from "@elizaos/shared";
import { DEFAULT_UI_LANGUAGE, ensureLanguageLoaded, MESSAGES, UI_LANGUAGES, } from "./messages";
// `normalizeLanguage` (and the language-code constants below) are owned by
// @elizaos/shared so Node route handlers can normalize without the renderer's
// message dictionaries. Re-exported here to preserve the `@elizaos/ui/i18n`
// public surface.
export { normalizeLanguage };
function interpolate(template, vars) {
    if (!vars)
        return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const raw = vars[key];
        if (raw == null)
            return "";
        return String(raw);
    });
}
function messageForLanguage(lang) {
    return MESSAGES[lang] ?? MESSAGES[DEFAULT_UI_LANGUAGE];
}
export function t(lang, key, vars) {
    const normalized = normalizeLanguage(lang);
    const localized = messageForLanguage(normalized);
    const english = messageForLanguage("en");
    const defaultValue = typeof vars?.defaultValue === "string" && vars.defaultValue.trim()
        ? vars.defaultValue
        : undefined;
    const template = localized[key] ?? english[key] ?? defaultValue ?? key;
    return interpolate(template, vars);
}
export function createTranslator(lang, defaultVars) {
    const normalized = normalizeLanguage(lang);
    return (key, vars) => {
        const merged = defaultVars && vars ? { ...defaultVars, ...vars } : (vars ?? defaultVars);
        return t(normalized, key, merged);
    };
}
export { DEFAULT_UI_LANGUAGE, ensureLanguageLoaded, MESSAGES, UI_LANGUAGES, };
