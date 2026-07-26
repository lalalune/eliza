/**
 * Desktop workspace helpers over the Electrobun bridge, including click-audit
 * entry-point tagging for tray/palette/settings launch points.
 */
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../bridge";
export const DESKTOP_WORKSPACE_SURFACES = [
    {
        id: "chat",
        label: "Chat Window",
        description: "Open a detached chat session window.",
    },
    {
        id: "release",
        label: "Release Center",
        description: "Open the detached release center window.",
    },
    {
        id: "triggers",
        label: "Triggers Window",
        description: "Open scheduled trigger controls in a detached window.",
    },
    {
        id: "plugins",
        label: "Plugins Window",
        description: "Open plugin controls in a detached window.",
    },
    {
        id: "cloud",
        label: "Cloud Window",
        description: "Open Eliza Cloud controls in a detached window.",
    },
];
function unsupportedSnapshot() {
    return {
        supported: false,
        version: null,
        packaged: null,
        autoLaunch: null,
        window: {
            bounds: null,
            maximized: false,
            minimized: false,
            visible: false,
            focused: false,
        },
        power: null,
        primaryDisplay: null,
        displays: [],
        cursor: null,
        clipboard: null,
        paths: {},
    };
}
export async function requestDesktopBridge(rpcMethod, ipcChannel, params) {
    return invokeDesktopBridgeRequest({ rpcMethod, ipcChannel, params });
}
export async function openDesktopSettingsWindow(tabHint) {
    await requestDesktopBridge("desktopOpenSettingsWindow", "desktop:openSettingsWindow", tabHint ? { tabHint } : undefined);
}
export async function openDesktopSurfaceWindow(surface, options) {
    await requestDesktopBridge("desktopOpenSurfaceWindow", "desktop:openSurfaceWindow", {
        surface,
        ...(surface === "browser" && options?.browse?.trim()
            ? { browse: options.browse.trim() }
            : {}),
    });
}
export async function loadDesktopWorkspaceSnapshot() {
    if (!isElectrobunRuntime()) {
        return unsupportedSnapshot();
    }
    const [version, packaged, autoLaunch, windowBounds, maximized, minimized, visible, focused, power, primaryDisplay, displays, cursor, clipboard, clipboardFormats, home, downloads, documents, userData,] = await Promise.all([
        requestDesktopBridge("desktopGetVersion", "desktop:getVersion"),
        requestDesktopBridge("desktopIsPackaged", "desktop:isPackaged"),
        requestDesktopBridge("desktopGetAutoLaunchStatus", "desktop:getAutoLaunchStatus"),
        requestDesktopBridge("desktopGetWindowBounds", "desktop:getWindowBounds"),
        requestDesktopBridge("desktopIsWindowMaximized", "desktop:isWindowMaximized"),
        requestDesktopBridge("desktopIsWindowMinimized", "desktop:isWindowMinimized"),
        requestDesktopBridge("desktopIsWindowVisible", "desktop:isWindowVisible"),
        requestDesktopBridge("desktopIsWindowFocused", "desktop:isWindowFocused"),
        requestDesktopBridge("desktopGetPowerState", "desktop:getPowerState"),
        requestDesktopBridge("desktopGetPrimaryDisplay", "desktop:getPrimaryDisplay"),
        requestDesktopBridge("desktopGetAllDisplays", "desktop:getAllDisplays"),
        requestDesktopBridge("desktopGetCursorPosition", "desktop:getCursorPosition"),
        requestDesktopBridge("desktopReadFromClipboard", "desktop:readFromClipboard"),
        requestDesktopBridge("desktopClipboardAvailableFormats", "desktop:clipboardAvailableFormats"),
        requestDesktopBridge("desktopGetPath", "desktop:getPath", {
            name: "home",
        }),
        requestDesktopBridge("desktopGetPath", "desktop:getPath", {
            name: "downloads",
        }),
        requestDesktopBridge("desktopGetPath", "desktop:getPath", {
            name: "documents",
        }),
        requestDesktopBridge("desktopGetPath", "desktop:getPath", {
            name: "userData",
        }),
    ]);
    return {
        supported: true,
        version,
        packaged: packaged?.packaged ?? null,
        autoLaunch,
        window: {
            bounds: windowBounds,
            maximized: maximized?.maximized ?? false,
            minimized: minimized?.minimized ?? false,
            visible: visible?.visible ?? false,
            focused: focused?.focused ?? false,
        },
        power,
        primaryDisplay,
        displays: displays?.displays ?? [],
        cursor,
        clipboard: clipboard
            ? {
                ...clipboard,
                formats: clipboardFormats?.formats ?? [],
            }
            : null,
        paths: {
            home: home?.path,
            downloads: downloads?.path,
            documents: documents?.path,
            userData: userData?.path,
        },
    };
}
function formatBounds(bounds) {
    if (!bounds) {
        return "unavailable";
    }
    return `${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y}`;
}
export function formatDesktopWorkspaceSummary(snapshot) {
    if (!snapshot.supported) {
        return "Desktop runtime unavailable";
    }
    return [
        snapshot.version
            ? `${snapshot.version.name} ${snapshot.version.version} (${snapshot.version.runtime})`
            : "Version unavailable",
        snapshot.packaged == null
            ? "Package state unknown"
            : snapshot.packaged
                ? "Packaged"
                : "Development build",
        snapshot.window.visible ? "Window visible" : "Window hidden",
        snapshot.window.focused ? "Window focused" : "Window unfocused",
        snapshot.window.maximized ? "Maximized" : "Windowed",
        snapshot.autoLaunch?.enabled ? "Auto-launch on" : "Auto-launch off",
        snapshot.displays.length > 0
            ? `${snapshot.displays.length} display${snapshot.displays.length === 1 ? "" : "s"}`
            : "No display info",
        snapshot.cursor
            ? `Cursor ${snapshot.cursor.x},${snapshot.cursor.y}`
            : "Cursor unavailable",
        `Bounds ${formatBounds(snapshot.window.bounds)}`,
    ].join(" · ");
}
