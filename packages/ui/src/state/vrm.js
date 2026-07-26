/**
 * Resolves bundled VRM avatar assets from boot config — count, slug lookup, and
 * asset URLs — with a fallback slug when none are declared.
 */
import { getBootConfig } from "../config/boot-config";
import { resolveAppAssetUrl } from "../utils/asset-url";
const BUNDLED_VRM_FALLBACK_SLUG = "bundled-1";
function getAssets() {
    const assets = getBootConfig().vrmAssets;
    if (Array.isArray(assets) && assets.length > 0) {
        return assets;
    }
    return [];
}
export function getVrmCount() {
    return getAssets().length;
}
export const VRM_COUNT = 8;
export function normalizeAvatarIndex(index) {
    if (!Number.isFinite(index))
        return 1;
    const n = Math.trunc(index);
    if (n === 0)
        return 0;
    const count = getAssets().length;
    if (n < 1 || n > count)
        return 1;
    return n;
}
export function getVrmUrl(index) {
    const assets = getAssets();
    if (assets.length === 0) {
        return resolveAppAssetUrl(`vrms/${BUNDLED_VRM_FALLBACK_SLUG}.vrm.gz`);
    }
    const n = normalizeAvatarIndex(index);
    const safe = n > 0 ? n : 1;
    const slug = assets[safe - 1]?.slug ?? assets[0]?.slug ?? "default";
    return resolveAppAssetUrl(`vrms/${slug}.vrm.gz`);
}
export function getVrmPreviewUrl(index) {
    const assets = getAssets();
    if (assets.length === 0) {
        return resolveAppAssetUrl(`vrms/previews/${BUNDLED_VRM_FALLBACK_SLUG}.png`);
    }
    const n = normalizeAvatarIndex(index);
    const safe = n > 0 ? n : 1;
    const slug = assets[safe - 1]?.slug ?? assets[0]?.slug ?? "default";
    return resolveAppAssetUrl(`vrms/previews/${slug}.png`);
}
export function getVrmBackgroundUrl(index) {
    const assets = getAssets();
    if (assets.length === 0) {
        return resolveAppAssetUrl(`vrms/backgrounds/${BUNDLED_VRM_FALLBACK_SLUG}.png`);
    }
    const n = normalizeAvatarIndex(index);
    const safe = n > 0 ? n : 1;
    const slug = assets[safe - 1]?.slug ?? assets[0]?.slug ?? "default";
    return resolveAppAssetUrl(`vrms/backgrounds/${slug}.png`);
}
const COMPANION_THEME_BACKGROUND_INDEX = {
    light: 3,
    dark: 4,
};
export function getCompanionBackgroundUrl(theme) {
    return getVrmBackgroundUrl(COMPANION_THEME_BACKGROUND_INDEX[theme]);
}
export function getVrmTitle(index) {
    const assets = getAssets();
    if (assets.length === 0)
        return "Avatar";
    const n = normalizeAvatarIndex(index);
    const safe = n > 0 ? n : 1;
    return assets[safe - 1]?.title ?? assets[0]?.title ?? "Avatar";
}
