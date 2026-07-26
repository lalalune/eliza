/**
 * Collects desktop agent diagnostics via the Electrobun bridge for the bug-report
 * form (agent state/phase snapshot).
 */
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../bridge";
export async function loadDesktopBugReportDiagnostics() {
    if (!isElectrobunRuntime()) {
        return null;
    }
    return invokeDesktopBridgeRequest({
        rpcMethod: "desktopGetStartupDiagnostics",
        ipcChannel: "desktop:getStartupDiagnostics",
    });
}
export async function openDesktopLogsFolder() {
    if (!isElectrobunRuntime()) {
        return;
    }
    await invokeDesktopBridgeRequest({
        rpcMethod: "desktopOpenLogsFolder",
        ipcChannel: "desktop:openLogsFolder",
    });
}
export async function createDesktopBugReportBundle(options) {
    if (!isElectrobunRuntime()) {
        return null;
    }
    return invokeDesktopBridgeRequest({
        rpcMethod: "desktopCreateBugReportBundle",
        ipcChannel: "desktop:createBugReportBundle",
        params: options,
    });
}
export function formatDesktopBugReportDiagnostics(diagnostics) {
    const lines = [
        `App Version: ${diagnostics.appVersion ?? "unknown"}`,
        `Runtime: ${diagnostics.appRuntime ?? "unknown"}`,
        `Packaged: ${diagnostics.packaged == null ? "unknown" : diagnostics.packaged ? "yes" : "no"}`,
        `Platform: ${diagnostics.platform} ${diagnostics.arch}`,
        `Locale: ${diagnostics.locale ?? "unknown"}`,
        `Startup State: ${diagnostics.state}`,
        `Startup Phase: ${diagnostics.phase}`,
        `Last Error: ${diagnostics.lastError ?? "none"}`,
        `Agent Name: ${diagnostics.agentName ?? "unknown"}`,
        `Port: ${diagnostics.port ?? "unknown"}`,
        `Updated At: ${diagnostics.updatedAt}`,
        `Log Path: ${diagnostics.logPath}`,
        `Status Path: ${diagnostics.statusPath}`,
    ];
    return lines.join("\n");
}
