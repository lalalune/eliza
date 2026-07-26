/**
 * Client-side helpers for the local-inference endpoints. Mirrors the
 * structure used by `client-computeruse.ts`: augments `ElizaClient` via
 * declaration merging so callers get typed methods without reaching into
 * raw `fetch` from UI code.
 */
import { ElizaClient } from "./client-base";
let localInferenceHubRequest = null;
/**
 * Classify a `HardwareProbe` into a coarse device tier for UI display.
 *
 * This is a deliberately small client-side approximation of the plugin's
 * `classifyDeviceTier` (which carries the authoritative R9 thresholds). The UI
 * only needs the tier label + a one-line reason to render the banner and the
 * per-slot "Auto" resolution; it does not gate runtime behaviour, so the full
 * server classifier is not required on the client.
 */
export function classifyDeviceTierFromProbe(probe) {
    const mobile = probe.mobile?.platform === "ios" || probe.mobile?.platform === "android";
    const cpuOnly = !probe.gpu && !probe.appleSilicon;
    const vramGb = probe.gpu?.totalVramGb ?? 0;
    const effectiveMemoryGb = probe.appleSilicon
        ? probe.totalRamGb
        : probe.gpu
            ? Math.max(vramGb, probe.totalRamGb * 0.5)
            : probe.totalRamGb * 0.5;
    const accelerator = probe.appleSilicon
        ? `Apple Silicon ${probe.totalRamGb.toFixed(0)} GB`
        : probe.gpu
            ? `${vramGb.toFixed(0)} GB VRAM`
            : `${probe.totalRamGb.toFixed(0)} GB RAM, ${probe.cpuCores} cores`;
    const reason = `${effectiveMemoryGb.toFixed(1)} GB effective · ${probe.freeRamGb.toFixed(1)} GB free · ${accelerator}`;
    const tier = (() => {
        // Mobile clamps to OKAY at best (OS background-task limits).
        if (mobile) {
            return probe.freeRamGb >= 3 ? "OKAY" : "POOR";
        }
        if (probe.cpuCores < 4)
            return "POOR";
        const meetsMax = effectiveMemoryGb >= 24 &&
            probe.freeRamGb >= 16 &&
            (vramGb >= 16 || (probe.appleSilicon && probe.totalRamGb >= 32));
        if (meetsMax)
            return "MAX";
        const meetsGood = effectiveMemoryGb >= 12 &&
            probe.freeRamGb >= 8 &&
            (vramGb >= 8 ||
                (probe.appleSilicon && probe.totalRamGb >= 16) ||
                (cpuOnly && probe.totalRamGb >= 32));
        if (meetsGood)
            return "GOOD";
        const meetsOkay = effectiveMemoryGb >= 6 && probe.freeRamGb >= 3;
        return meetsOkay ? "OKAY" : "POOR";
    })();
    return { tier, reason, cpuOnly, mobile };
}
ElizaClient.prototype.getLocalInferenceHub = async function () {
    localInferenceHubRequest ??= this.fetch("/api/local-inference/hub", undefined, { timeoutMs: 30_000 }).finally(() => {
        localInferenceHubRequest = null;
    });
    return localInferenceHubRequest;
};
ElizaClient.prototype.getLocalInferenceHardware = async function () {
    return this.fetch("/api/local-inference/hardware");
};
ElizaClient.prototype.getLocalInferenceDeviceTier = async function () {
    // Prefer the authoritative server assessment (same one the router's AUTO policy
    // consumes) so the UI's tier/recommendedMode/recommendedFit cannot disagree with
    // the actual routing decision. Fall back to the coarse client estimate only when
    // the endpoint is unavailable (older agent, transient error).
    try {
        const res = (await this.fetch("/api/local-inference/device-tier"));
        const a = res?.tier;
        if (a && typeof a.tier === "string") {
            const nc = a.numericContext ?? {};
            return {
                tier: a.tier,
                reason: a.reasons?.[0] ?? "",
                cpuOnly: !nc.vramGb && !nc.appleSilicon,
                mobile: Boolean(nc.mobile),
                recommendedMode: a.recommendedMode,
                canRunLocalLm: a.canRunLocalLm,
                canRunLocalVoice: a.canRunLocalVoice,
                recommendedFit: a.recommendedFit ?? null,
            };
        }
    }
    catch {
        // fall through to the client-side approximation
    }
    const probe = await this.getLocalInferenceHardware();
    return classifyDeviceTierFromProbe(probe);
};
ElizaClient.prototype.getLocalInferenceCatalog = async function () {
    return this.fetch("/api/local-inference/catalog");
};
ElizaClient.prototype.getLocalInferenceInstalled = async function () {
    return this.fetch("/api/local-inference/installed");
};
ElizaClient.prototype.startLocalInferenceDownload = async function (modelId) {
    return this.fetch("/api/local-inference/downloads", {
        method: "POST",
        body: JSON.stringify({ modelId }),
    });
};
ElizaClient.prototype.searchHuggingFaceGguf = async function (query, limit, hub = "huggingface") {
    const params = new URLSearchParams({ q: query });
    if (limit != null)
        params.set("limit", String(limit));
    params.set("hub", hub);
    return this.fetch(`/api/local-inference/hf-search?${params.toString()}`);
};
ElizaClient.prototype.cancelLocalInferenceDownload = async function (modelId) {
    return this.fetch(`/api/local-inference/downloads/${encodeURIComponent(modelId)}`, { method: "DELETE" });
};
ElizaClient.prototype.getLocalInferenceActive = async function () {
    return this.fetch("/api/local-inference/active");
};
ElizaClient.prototype.setLocalInferenceActive = async function (modelId) {
    return this.fetch("/api/local-inference/active", {
        method: "POST",
        body: JSON.stringify({ modelId }),
    });
};
ElizaClient.prototype.clearLocalInferenceActive = async function () {
    return this.fetch("/api/local-inference/active", {
        method: "DELETE",
    });
};
ElizaClient.prototype.uninstallLocalInferenceModel = async function (id) {
    return this.fetch(`/api/local-inference/installed/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.getLocalInferenceDeviceStatus = async function () {
    return this.fetch("/api/local-inference/device");
};
ElizaClient.prototype.getLocalInferenceProviders = async function () {
    return this.fetch("/api/local-inference/providers");
};
ElizaClient.prototype.getLocalInferenceAssignments = async function () {
    return this.fetch("/api/local-inference/assignments");
};
ElizaClient.prototype.setLocalInferenceAssignment = async function (slot, modelId) {
    return this.fetch("/api/local-inference/assignments", {
        method: "POST",
        body: JSON.stringify({ slot, modelId }),
    });
};
ElizaClient.prototype.verifyLocalInferenceModel = async function (id) {
    return this.fetch(`/api/local-inference/installed/${encodeURIComponent(id)}/verify`, { method: "POST" });
};
ElizaClient.prototype.getLocalInferenceRouting = async function () {
    return this.fetch("/api/local-inference/routing");
};
ElizaClient.prototype.setLocalInferencePreferredProvider = async function (slot, provider) {
    return this.fetch("/api/local-inference/routing/preferred", {
        method: "POST",
        body: JSON.stringify({ slot, provider }),
    });
};
ElizaClient.prototype.setLocalInferencePolicy = async function (slot, policy) {
    return this.fetch("/api/local-inference/routing/policy", {
        method: "POST",
        body: JSON.stringify({ slot, policy }),
    });
};
