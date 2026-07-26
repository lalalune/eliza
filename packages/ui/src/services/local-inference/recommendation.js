/**
 * First-run model recommendation: picks the best-fitting eligible Eliza-1 tier
 * for the probed hardware and computes catalog download sizes.
 */
import { DEFAULT_ELIGIBLE_MODEL_IDS, eliza1TierPublishStatus, FIRST_RUN_DEFAULT_MODEL_ID, MODEL_CATALOG, } from "./catalog";
import { assessFit } from "./hardware";
const BYTES_PER_GB = 1024 ** 3;
/**
 * Per-platform slot ladders. Every default-recommended entry is an
 * Eliza-1 tier (the only default-eligible line — see catalog.ts and
 * `packages/inference/AGENTS.md` §2). Ladders bias toward the smallest
 * tier that fits the platform; desktops/servers pick larger tiers
 * first when memory headroom allows.
 */
const TIER_2B = "eliza-1-2b";
const TIER_4B = "eliza-1-4b";
const TIER_9B = "eliza-1-9b";
const TIER_27B = "eliza-1-27b";
const SLOT_LADDERS = {
    // 4B is the shipped mobile minimum — the 2B entry tier is too small for a
    // quality chat experience, so the mobile ladder floors at 4B for both slots.
    // If a low-RAM phone genuinely can't fit 4B, `fallbackCandidates` still
    // degrades to the 2B entry tier rather than failing outright.
    mobile: {
        TEXT_SMALL: [TIER_4B],
        TEXT_LARGE: [TIER_4B],
    },
    "apple-silicon": {
        TEXT_SMALL: [TIER_2B, TIER_4B],
        TEXT_LARGE: [TIER_27B, TIER_9B, TIER_4B, TIER_2B],
    },
    "linux-gpu": {
        TEXT_SMALL: [TIER_2B, TIER_4B],
        TEXT_LARGE: [TIER_27B, TIER_9B, TIER_4B, TIER_2B],
    },
    "linux-cpu": {
        TEXT_SMALL: [TIER_2B, TIER_4B],
        TEXT_LARGE: [TIER_9B, TIER_4B, TIER_2B],
    },
    "desktop-gpu": {
        TEXT_SMALL: [TIER_2B, TIER_4B],
        TEXT_LARGE: [TIER_27B, TIER_9B, TIER_4B, TIER_2B],
    },
    "desktop-cpu": {
        TEXT_SMALL: [TIER_2B, TIER_4B],
        TEXT_LARGE: [TIER_9B, TIER_4B, TIER_2B],
    },
};
function catalogById(catalog) {
    return new Map(catalog.map((model) => [model.id, model]));
}
function chatCandidates(catalog) {
    return catalog.filter((model) => !model.hiddenFromCatalog);
}
export function classifyRecommendationPlatform(hardware) {
    const platform = hardware.mobile?.platform ?? hardware.platform;
    if (platform === "android" || platform === "ios")
        return "mobile";
    if (hardware.appleSilicon)
        return "apple-silicon";
    if (platform === "linux" && hardware.gpu)
        return "linux-gpu";
    if (platform === "linux")
        return "linux-cpu";
    if (hardware.gpu)
        return "desktop-gpu";
    return "desktop-cpu";
}
export function catalogDownloadSizeGb(model, catalog = MODEL_CATALOG) {
    void catalog;
    return model.sizeGb;
}
export function catalogDownloadSizeBytes(model, catalog = MODEL_CATALOG) {
    return Math.round(catalogDownloadSizeGb(model, catalog) * BYTES_PER_GB);
}
function mobileFit(hardware, model, catalog) {
    const sizeGb = catalogDownloadSizeGb(model, catalog);
    if (hardware.totalRamGb < model.minRamGb)
        return "wontfit";
    if (sizeGb > hardware.totalRamGb * 0.8)
        return "wontfit";
    if (sizeGb > hardware.totalRamGb * 0.65)
        return "tight";
    return "fits";
}
export function assessCatalogModelFit(hardware, model, catalog = MODEL_CATALOG) {
    if (classifyRecommendationPlatform(hardware) === "mobile") {
        return mobileFit(hardware, model, catalog);
    }
    return assessFit(hardware, catalogDownloadSizeGb(model, catalog), model.minRamGb);
}
function canFit(hardware, model, catalog) {
    return assessCatalogModelFit(hardware, model, catalog) !== "wontfit";
}
/**
 * True when every kernel listed in `model.runtime.optimizations.requiresKernel`
 * is advertised as `true` in the binary's CAPABILITIES.json kernels map.
 *
 * `binaryKernels === null` means we have no probe (older binary, or
 * llama-server isn't installed). In that case we trust the catalog —
 * filtering would hide every kernel-required model and the dispatcher's
 * load-time check will surface the real error if/when the user tries to
 * activate it.
 *
 * `unsupportedKernels` is a soft signal layered on top: when the binary
 * has no satisfied `requiresKernel` anchor and exposes only an unsupported
 * backend (OpenVINO-only Intel build for an Eliza-1 text tier), drop the
 * tier so the recommender doesn't suggest a path that has no kernel route.
 * A binary that already satisfies `requiresKernel` stays eligible even
 * when it also advertises an unsupported backend (e.g. OpenVINO
 * co-compiled — the dispatcher steers the spawn off OpenVINO via
 * `applyUnsupportedKernelEnv` at runtime).
 */
function kernelRequirementsSatisfied(model, binaryKernels) {
    const required = model.runtime?.optimizations?.requiresKernel ?? [];
    if (!binaryKernels)
        return true;
    if (required.length > 0) {
        return required.every((k) => binaryKernels[k] === true);
    }
    const unsupported = model.runtime?.optimizations?.unsupportedKernels ?? [];
    return !unsupported.some((k) => binaryKernels[k] === true);
}
function modelsFromLadder(ids, catalog) {
    const byId = catalogById(catalog);
    return ids.flatMap((id) => {
        const model = byId.get(id);
        return model ? [model] : [];
    });
}
/**
 * True when this host has enough memory headroom to serve the long-context
 * KV cache for a 64k+ window. Threshold mirrors the "16 GB workstation"
 * line from the porting plan — a 64k context for an 8B model at fp16 KV
 * occupies ~4 GB; with TurboQuant compression it fits inside 1 GB. Below
 * 16 GB total we keep the historical short-context preference.
 *
 * For GPU hosts we look at total VRAM, since the KV cache lives wherever
 * the layers do; for CPU-only hosts we look at total RAM.
 */
const LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB = 16;
const LONG_CONTEXT_MIN_LENGTH = 65536;
function hasLongContextHeadroom(hardware) {
    const vramGb = hardware.gpu?.totalVramGb ?? 0;
    if (vramGb >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB)
        return true;
    return hardware.totalRamGb >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB;
}
function isLongContextModel(model) {
    return (typeof model.contextLength === "number" &&
        model.contextLength >= LONG_CONTEXT_MIN_LENGTH);
}
function fallbackCandidates(slot, hardware, catalog) {
    const candidates = chatCandidates(catalog).filter((model) => DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id) &&
        canFit(hardware, model, catalog));
    const preferLongContext = hasLongContextHeadroom(hardware);
    return candidates.sort((left, right) => {
        if (preferLongContext) {
            const leftLong = isLongContextModel(left) ? 1 : 0;
            const rightLong = isLongContextModel(right) ? 1 : 0;
            if (leftLong !== rightLong)
                return rightLong - leftLong;
        }
        const sizeDelta = catalogDownloadSizeGb(right, catalog) -
            catalogDownloadSizeGb(left, catalog);
        return slot === "TEXT_LARGE" ? sizeDelta : -sizeDelta;
    });
}
export function selectRecommendedModelForSlot(slot, hardware, catalog = MODEL_CATALOG, options = {}) {
    const platformClass = classifyRecommendationPlatform(hardware);
    const ladder = modelsFromLadder(SLOT_LADDERS[platformClass][slot], catalog);
    const binaryKernels = options.binaryKernels ?? null;
    const eligible = ladder.filter((model) => canFit(hardware, model, catalog) &&
        kernelRequirementsSatisfied(model, binaryKernels));
    // On hosts with >= 16 GB RAM/VRAM, give long-context (>= 64k) ladder
    // entries a small bump so we surface 128k models when they fit. The
    // ladder order still wins when long-context availability is the same
    // for every entry (or when the host doesn't have the headroom).
    const ranked = slot === "TEXT_LARGE" &&
        eligible.length > 0 &&
        hasLongContextHeadroom(hardware)
        ? rankLadderByLongContext(eligible)
        : eligible;
    const alternatives = ranked.length > 0
        ? ranked
        : fallbackCandidates(slot, hardware, catalog).filter((model) => kernelRequirementsSatisfied(model, binaryKernels));
    const model = alternatives[0] ?? null;
    const fit = model ? assessCatalogModelFit(hardware, model, catalog) : null;
    return {
        slot,
        platformClass,
        model,
        fit,
        reason: model
            ? `${platformClass} ${slot} ladder selected ${model.id}`
            : `${platformClass} ${slot} ladder has no fitting catalog model`,
        alternatives,
    };
}
/**
 * Stable sort that pulls long-context models toward the front while
 * preserving relative order within each group. Used only on hosts with
 * the long-context RAM/VRAM headroom — the ladder order remains the
 * tie-breaker so native-runtime preferences survive.
 */
function rankLadderByLongContext(ladder) {
    return ladder
        .map((model, idx) => ({ model, idx, long: isLongContextModel(model) }))
        .sort((left, right) => {
        if (left.long !== right.long)
            return right.long ? 1 : -1;
        return left.idx - right.idx;
    })
        .map((entry) => entry.model);
}
export function selectRecommendedModels(hardware, catalog = MODEL_CATALOG, options = {}) {
    return {
        TEXT_SMALL: selectRecommendedModelForSlot("TEXT_SMALL", hardware, catalog, options),
        TEXT_LARGE: selectRecommendedModelForSlot("TEXT_LARGE", hardware, catalog, options),
    };
}
/**
 * Pick the model the engine should auto-load on first run when no user
 * preference exists. Always resolves to an Eliza-1 default-eligible
 * tier — never a non-Eliza catalog entry, never a HF-search result.
 *
 * Resolution order (mirrors `app-core` recommendation.ts):
 *   1. `FIRST_RUN_DEFAULT_MODEL_ID` when present in the catalog, in the
 *      default-eligible set, and not marked `publishStatus: "pending"`.
 *   2. The first default-eligible, non-pending chat entry in the catalog
 *      as a fallback when the preferred id's HF bundle isn't published
 *      yet (elizaOS/eliza#7629).
 *   3. If every default-eligible tier is pending, last-resort to ANY
 *      default-eligible tier so the download path surfaces the 404
 *      cleanly rather than silently picking a non-Eliza model.
 *
 * Returns null only when no default-eligible entry exists at all —
 * which means the catalog is misconfigured and the caller should
 * surface a hard error rather than degrade silently.
 */
export function recommendForFirstRun(catalog = MODEL_CATALOG) {
    const byId = catalogById(catalog);
    const isEligibleChat = (model) => !model.hiddenFromCatalog && DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id);
    const publishStatusFor = (model) => model.publishStatus ?? eliza1TierPublishStatus(model.id);
    const isPublishedEligibleChat = (model) => isEligibleChat(model) && publishStatusFor(model) === "published";
    const preferred = byId.get(FIRST_RUN_DEFAULT_MODEL_ID);
    if (preferred && isPublishedEligibleChat(preferred))
        return preferred;
    const fallbackPublished = catalog.find(isPublishedEligibleChat);
    if (fallbackPublished)
        return fallbackPublished;
    // Last-resort: prefer the configured first-run default even when its
    // bundle is unpublished, so the downloader's 404 surfaces with the
    // tier the user expected to land on.
    if (preferred && isEligibleChat(preferred))
        return preferred;
    return catalog.find(isEligibleChat) ?? null;
}
export function chooseSmallerFallbackModel(currentModelId, hardware, slot = "TEXT_LARGE", catalog = MODEL_CATALOG) {
    const byId = catalogById(catalog);
    const current = byId.get(currentModelId);
    const currentSize = current
        ? catalogDownloadSizeGb(current, catalog)
        : Number.POSITIVE_INFINITY;
    const platformClass = classifyRecommendationPlatform(hardware);
    const ladderFallback = modelsFromLadder(SLOT_LADDERS[platformClass][slot], catalog)
        .filter((model) => model.id !== currentModelId)
        .filter((model) => catalogDownloadSizeGb(model, catalog) < currentSize)
        .filter((model) => canFit(hardware, model, catalog))[0];
    if (ladderFallback)
        return ladderFallback;
    return (fallbackCandidates(slot, hardware, catalog)
        .filter((model) => model.id !== currentModelId)
        .filter((model) => catalogDownloadSizeGb(model, catalog) < currentSize)[0] ?? null);
}
