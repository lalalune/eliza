/**
 * Resolves the first-run runtime target for the current platform (Android/iOS
 * local IPC bases vs the configured API base).
 */
import { isAndroid, isIOS } from "../platform/init";
import { getElizaApiBase } from "../utils";
import { ANDROID_LOCAL_AGENT_IPC_BASE, IOS_LOCAL_AGENT_IPC_BASE, } from "./mobile-runtime-mode";
const DEFAULT_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";
/**
 * The API base the on-device local agent listens on. iOS/Android use their
 * native IPC bases; everything else falls back to the injected Eliza API base
 * (desktop bridge / dev server) or the default loopback port. Relocated here
 * from the deleted first-run voice stack — it is NOT voice, and the headless
 * first-run finish use case needs it to boot the local runtime.
 */
export function resolveFirstRunLocalAgentApiBase() {
    if (isIOS)
        return IOS_LOCAL_AGENT_IPC_BASE;
    if (isAndroid)
        return ANDROID_LOCAL_AGENT_IPC_BASE;
    return getElizaApiBase() ?? DEFAULT_LOCAL_AGENT_API_BASE;
}
export function isElizaCloudFirstRunTarget(target) {
    return target === "elizacloud" || target === "elizacloud-hybrid";
}
export function activeServerKindToFirstRunRuntimeTarget(kind) {
    switch (kind) {
        case "local":
            return "local";
        case "cloud":
            return "elizacloud";
        case "remote":
            return "remote";
    }
}
