/**
 * ElizaClient extension for the desktop browser workspace: snapshot, open, and
 * navigate tabs through the Electrobun bridge.
 */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { ElizaClient } from "./client-base";
async function requestDesktopBrowserWorkspace(options) {
    if (!isElectrobunRuntime()) {
        return null;
    }
    return invokeDesktopBridgeRequest(options);
}
ElizaClient.prototype.getBrowserWorkspace = async function () {
    const bridged = await requestDesktopBrowserWorkspace({
        rpcMethod: "browserWorkspaceGetSnapshot",
        ipcChannel: "browser-workspace:getSnapshot",
    });
    if (bridged) {
        return bridged;
    }
    return this.fetch("/api/browser-workspace");
};
ElizaClient.prototype.openBrowserWorkspaceTab = async function (request) {
    const bridged = await requestDesktopBrowserWorkspace({
        rpcMethod: "browserWorkspaceOpenTab",
        ipcChannel: "browser-workspace:openTab",
        params: request,
    });
    if (bridged) {
        return bridged;
    }
    return this.fetch("/api/browser-workspace/tabs", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.navigateBrowserWorkspaceTab = async function (id, url) {
    const params = { id, url };
    const bridged = await requestDesktopBrowserWorkspace({
        rpcMethod: "browserWorkspaceNavigateTab",
        ipcChannel: "browser-workspace:navigateTab",
        params,
    });
    if (bridged) {
        return bridged;
    }
    return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/navigate`, {
        method: "POST",
        body: JSON.stringify({ url }),
    });
};
ElizaClient.prototype.showBrowserWorkspaceTab = async function (id) {
    const bridged = await requestDesktopBrowserWorkspace({
        rpcMethod: "browserWorkspaceShowTab",
        ipcChannel: "browser-workspace:showTab",
        params: { id },
    });
    if (bridged) {
        return bridged;
    }
    return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/show`, {
        method: "POST",
    });
};
ElizaClient.prototype.hideBrowserWorkspaceTab = async function (id) {
    const bridged = await requestDesktopBrowserWorkspace({
        rpcMethod: "browserWorkspaceHideTab",
        ipcChannel: "browser-workspace:hideTab",
        params: { id },
    });
    if (bridged) {
        return bridged;
    }
    return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/hide`, {
        method: "POST",
    });
};
ElizaClient.prototype.closeBrowserWorkspaceTab = async function (id) {
    const bridged = await requestDesktopBrowserWorkspace({
        rpcMethod: "browserWorkspaceCloseTab",
        ipcChannel: "browser-workspace:closeTab",
        params: { id },
    });
    if (bridged) {
        return bridged;
    }
    return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.snapshotBrowserWorkspaceTab = async function (id) {
    const bridged = await requestDesktopBrowserWorkspace({
        rpcMethod: "browserWorkspaceSnapshotTab",
        ipcChannel: "browser-workspace:snapshotTab",
        params: { id },
    });
    if (bridged) {
        return bridged;
    }
    return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}/snapshot`);
};
