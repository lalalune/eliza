function getDesktopBridgeWindow() {
    const g = globalThis;
    if (typeof g.window !== "undefined") {
        return g.window;
    }
    if (typeof window !== "undefined") {
        return window;
    }
    return null;
}
export function getElectrobunRendererRpc() {
    return getDesktopBridgeWindow()?.__ELIZA_ELECTROBUN_RPC__;
}
export async function invokeDesktopBridgeRequest(options) {
    const rpc = getElectrobunRendererRpc();
    const request = rpc?.request?.[options.rpcMethod];
    if (request && rpc?.request) {
        return (await request.call(rpc.request, options.params));
    }
    return null;
}
/**
 * Same as `invokeDesktopBridgeRequest`, but never hangs past `timeoutMs`.
 * Use after native dialogs when a missing or wedged RPC would freeze the UI.
 */
export async function invokeDesktopBridgeRequestWithTimeout(options) {
    const rpc = getElectrobunRendererRpc();
    const request = rpc?.request?.[options.rpcMethod];
    if (!request || !rpc?.request) {
        return { status: "missing" };
    }
    const call = request.call(rpc.request, options.params);
    let tid;
    const timeoutPromise = new Promise((resolve) => {
        tid = setTimeout(() => resolve({ tag: "timeout" }), options.timeoutMs);
    });
    const settledPromise = call.then((value) => ({ tag: "done", value: value }), (error) => ({ tag: "reject", error }));
    try {
        const winner = await Promise.race([
            settledPromise,
            timeoutPromise,
        ]);
        if (tid !== undefined)
            clearTimeout(tid);
        if (winner.tag === "timeout")
            return { status: "timeout" };
        if (winner.tag === "reject") {
            return { status: "rejected", error: winner.error };
        }
        return { status: "ok", value: winner.value };
    }
    catch (error) {
        if (tid !== undefined)
            clearTimeout(tid);
        return { status: "rejected", error };
    }
}
export async function registerDynamicView(manifest, options) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "dynamicViewRegister",
        ipcChannel: "dynamic-view:register",
        params: { manifest, update: options?.update === true },
    });
}
export async function unregisterDynamicView(viewId) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "dynamicViewUnregister",
        ipcChannel: "dynamic-view:unregister",
        params: { viewId },
    });
}
export async function scanProviderCredentials() {
    const result = await invokeDesktopBridgeRequest({
        rpcMethod: "credentialsScanProviders",
        ipcChannel: "credentials:scanProviders",
        params: { context: "first-run" },
    });
    return result?.providers ?? [];
}
export async function inspectExistingElizaInstall() {
    return invokeDesktopBridgeRequest({
        rpcMethod: "agentInspectExistingInstall",
        ipcChannel: "agent:inspectExistingInstall",
    });
}
export async function pickDesktopWorkspaceFolder(options) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "desktopPickWorkspaceFolder",
        ipcChannel: "desktop:pickWorkspaceFolder",
        params: options ?? {},
    });
}
export async function desktopOpenPath(path) {
    await invokeDesktopBridgeRequest({
        rpcMethod: "desktopOpenPath",
        ipcChannel: "desktop:openPath",
        params: { path },
    });
}
/**
 * Open a view as its own desktop window (#9953 Phase 3). Backs "show a view"
 * from the chromeless bottom-bar shell, where there is no full-app tab system to
 * host the view inline. Returns the managed-window id, or null when the bridge
 * is unavailable (non-desktop).
 */
export async function openDesktopAppWindow(options) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
            slug: options.slug,
            title: options.title,
            path: options.path,
            alwaysOnTop: options.alwaysOnTop === true,
        },
    });
}
/** Route path for the on-demand launcher/dashboard window. */
export const DESKTOP_LAUNCHER_WINDOW_PATH = "/views";
/**
 * Summon the launcher (the views/app springboard) as its own desktop window
 * (#9953 Phase 3). The bottom bar is the resting surface; the launcher is an
 * on-demand window, not the resting surface.
 */
export async function openDesktopLauncherWindow() {
    return openDesktopAppWindow({
        slug: "launcher",
        title: "Launcher",
        path: DESKTOP_LAUNCHER_WINDOW_PATH,
    });
}
export async function desktopShowItemInFolder(path) {
    await invokeDesktopBridgeRequest({
        rpcMethod: "desktopShowItemInFolder",
        ipcChannel: "desktop:showItemInFolder",
        params: { path },
    });
}
export async function migrateDesktopStateDir(fromPath) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "agentMigrateStateDir",
        ipcChannel: "agent:migrateStateDir",
        params: { fromPath },
    });
}
export async function resolveDesktopWorkspaceFolderBookmark(bookmark) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "desktopResolveWorkspaceFolderBookmark",
        ipcChannel: "desktop:resolveWorkspaceFolderBookmark",
        params: { bookmark },
    });
}
export async function releaseDesktopWorkspaceFolderBookmarks() {
    return invokeDesktopBridgeRequest({
        rpcMethod: "desktopReleaseWorkspaceFolderBookmarks",
        ipcChannel: "desktop:releaseWorkspaceFolderBookmarks",
    });
}
export async function getDesktopRuntimeMode() {
    return invokeDesktopBridgeRequest({
        rpcMethod: "desktopGetRuntimeMode",
        ipcChannel: "desktop:getRuntimeMode",
    });
}
export async function getDesktopRemotePluginStoreRoot() {
    const result = await invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginGetStoreRoot",
        ipcChannel: "remote-plugin:getStoreRoot",
    });
    return result?.storeRoot ?? null;
}
export async function listDesktopRemotePlugins() {
    const result = await invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginList",
        ipcChannel: "remote-plugin:list",
    });
    return result?.remotePlugins ?? null;
}
export async function getDesktopRemotePluginStoreSnapshot() {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginGetStoreSnapshot",
        ipcChannel: "remote-plugin:getStoreSnapshot",
    });
}
export async function getDesktopRemotePlugin(id) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginGet",
        ipcChannel: "remote-plugin:get",
        params: { id },
    });
}
export async function installDesktopRemotePluginFromDirectory(options) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginInstallFromDirectory",
        ipcChannel: "remote-plugin:installFromDirectory",
        params: options,
    });
}
export async function uninstallDesktopRemotePlugin(id) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginUninstall",
        ipcChannel: "remote-plugin:uninstall",
        params: { id },
    });
}
export async function startDesktopRemotePluginWorker(id) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginStartWorker",
        ipcChannel: "remote-plugin:startWorker",
        params: { id },
    });
}
export async function stopDesktopRemotePluginWorker(id) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginStopWorker",
        ipcChannel: "remote-plugin:stopWorker",
        params: { id },
    });
}
export async function getDesktopRemotePluginWorkerStatus(id) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginGetWorkerStatus",
        ipcChannel: "remote-plugin:getWorkerStatus",
        params: { id },
    });
}
export async function listDesktopRemotePluginWorkerStatuses() {
    const result = await invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginListWorkerStatuses",
        ipcChannel: "remote-plugin:listWorkerStatuses",
    });
    return result?.workers ?? null;
}
export async function getDesktopRemotePluginLogs(id, maxBytes) {
    return invokeDesktopBridgeRequest({
        rpcMethod: "remotePluginGetLogs",
        ipcChannel: "remote-plugin:getLogs",
        params: { id, ...(maxBytes === undefined ? {} : { maxBytes }) },
    });
}
export function subscribeDesktopBridgeEvent(options) {
    const rpc = getElectrobunRendererRpc();
    if (rpc) {
        rpc.onMessage(options.rpcMessage, options.listener);
        return () => {
            rpc.offMessage(options.rpcMessage, options.listener);
        };
    }
    return () => { };
}
export function subscribeDesktopRemotePluginStoreChanged(listener) {
    return subscribeDesktopBridgeEvent({
        rpcMessage: "remotePluginStoreChanged",
        ipcChannel: "remote-plugin:storeChanged",
        listener: (payload) => {
            const snapshot = payload?.snapshot;
            if (snapshot)
                listener(snapshot);
        },
    });
}
export function subscribeDesktopRemotePluginWorkerChanged(listener) {
    return subscribeDesktopBridgeEvent({
        rpcMessage: "remotePluginWorkerChanged",
        ipcChannel: "remote-plugin:workerChanged",
        listener: (payload) => {
            const status = payload
                ?.status;
            if (status)
                listener(status);
        },
    });
}
