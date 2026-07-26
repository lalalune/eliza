export const SUPPORTED_BACKENDS_BY_TIER = {
    "2b": ["cpu", "metal", "cuda", "vulkan"],
    "4b": ["cpu", "metal", "cuda", "vulkan"],
    "9b": ["cpu", "metal", "cuda", "vulkan"],
    "27b": ["metal", "cuda", "vulkan"],
    "27b-256k": ["metal", "cuda", "vulkan"],
};
function isObject(value) {
    return Boolean(value) && typeof value === "object";
}
export function parseManifestOrThrow(input) {
    if (!isObject(input)) {
        throw new Error("Invalid Eliza-1 manifest: expected object");
    }
    const manifest = input;
    if (typeof manifest.id !== "string" || typeof manifest.version !== "string") {
        throw new Error("Invalid Eliza-1 manifest: missing id or version");
    }
    if (!manifest.files?.text?.length || !manifest.ramBudgetMb) {
        throw new Error("Invalid Eliza-1 manifest: missing required files or RAM budget");
    }
    if (!manifest.kernels?.verifiedBackends || !manifest.tier) {
        throw new Error("Invalid Eliza-1 manifest: missing kernel verification data");
    }
    return manifest;
}
