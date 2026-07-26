/**
 * Capacitor Bridge
 *
 * This module provides a bridge between the web UI and native
 * Capacitor plugins. It exposes a global API that the UI can use to
 * access native capabilities like camera, microphone, file system, etc.
 *
 * The bridge is designed to be progressively enhanced - features are
 * only available when running on platforms that support them.
 */
import { Capacitor } from "@capacitor/core";
import { BRIDGE_READY_EVENT, dispatchAppEvent } from "../events";
import { isElectrobunRuntime } from "./electrobun-runtime";
// Import the plugin bridge
import { getPluginCapabilities, getPlugins, isFeatureAvailable, } from "./plugin-bridge";
// Platform detection
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";
function isDesktopPlatform() {
    return isElectrobunRuntime();
}
function isWebPlatform() {
    return platform === "web" && !isElectrobunRuntime();
}
/**
 * Get the current platform capabilities
 */
export function getCapabilities() {
    const isDesktop = isDesktopPlatform();
    return {
        native: isNative,
        platform: (isDesktop
            ? "electrobun"
            : platform),
        haptics: isNative && (isIOS || isAndroid),
        camera: isNative,
        microphone: isNative,
        screenCapture: isNative && !isDesktop, // Desktop uses a separate capture path
        fileSystem: isNative,
        notifications: isNative,
        geolocation: true, // Available on web too via browser API
        background: isNative && !isDesktop,
        voiceWake: isNative && (isIOS || isAndroid), // macOS via Swabble handled separately
    };
}
/**
 * Lazy-load @capacitor/haptics on demand. Keeping it out of the static module
 * graph means server consumers that pull in the @elizaos/ui barrel (e.g.
 * plugin-inbox in the Node agent image) don't crash resolving a native-only,
 * mobile-only devDependency. Only ever invoked behind an `isNative` guard.
 */
function loadHaptics() {
    return import("@capacitor/haptics");
}
/**
 * Haptic feedback wrapper
 */
export const haptics = {
    /**
     * Trigger a light impact haptic (for UI interactions)
     */
    async light() {
        if (!isNative)
            return;
        const { Haptics, ImpactStyle } = await loadHaptics();
        await Haptics.impact({ style: ImpactStyle.Light });
    },
    /**
     * Trigger a medium impact haptic (for confirmations)
     */
    async medium() {
        if (!isNative)
            return;
        const { Haptics, ImpactStyle } = await loadHaptics();
        await Haptics.impact({ style: ImpactStyle.Medium });
    },
    /**
     * Trigger a heavy impact haptic (for important actions)
     */
    async heavy() {
        if (!isNative)
            return;
        const { Haptics, ImpactStyle } = await loadHaptics();
        await Haptics.impact({ style: ImpactStyle.Heavy });
    },
    /**
     * Trigger a success notification haptic
     */
    async success() {
        if (!isNative)
            return;
        const { Haptics, NotificationType } = await loadHaptics();
        await Haptics.notification({ type: NotificationType.Success });
    },
    /**
     * Trigger a warning notification haptic
     */
    async warning() {
        if (!isNative)
            return;
        const { Haptics, NotificationType } = await loadHaptics();
        await Haptics.notification({ type: NotificationType.Warning });
    },
    /**
     * Trigger an error notification haptic
     */
    async error() {
        if (!isNative)
            return;
        const { Haptics, NotificationType } = await loadHaptics();
        await Haptics.notification({ type: NotificationType.Error });
    },
    /**
     * Start a selection change haptic (for pickers)
     */
    async selectionStart() {
        if (!isNative)
            return;
        const { Haptics } = await loadHaptics();
        await Haptics.selectionStart();
    },
    /**
     * Trigger selection changed haptic
     */
    async selectionChanged() {
        if (!isNative)
            return;
        const { Haptics } = await loadHaptics();
        await Haptics.selectionChanged();
    },
    /**
     * End selection change haptic
     */
    async selectionEnd() {
        if (!isNative)
            return;
        const { Haptics } = await loadHaptics();
        await Haptics.selectionEnd();
    },
};
const pluginRegistry = new Map();
/**
 * Register a custom plugin
 */
export function registerPlugin(name, plugin) {
    pluginRegistry.set(name, plugin);
}
/**
 * Get a registered plugin
 */
export function getPlugin(name) {
    return pluginRegistry.get(name);
}
/**
 * Check if a plugin is registered
 */
export function hasPlugin(name) {
    return pluginRegistry.has(name);
}
/**
 * Create the global bridge object
 */
function createBridge() {
    const isDesktop = isDesktopPlatform();
    return {
        capabilities: getCapabilities(),
        pluginCapabilities: getPluginCapabilities(),
        haptics,
        getPlugin,
        hasPlugin,
        registerPlugin,
        plugins: getPlugins(),
        isFeatureAvailable,
        platform: {
            name: platform,
            isNative,
            isIOS,
            isAndroid,
            isDesktop,
            isWeb: isWebPlatform(),
            isMacOS: isDesktop, // Electrobun is used for macOS/desktop
        },
    };
}
/**
 * Initialize the Capacitor bridge
 *
 * This exposes the bridge object on window.Eliza for use by the UI.
 */
export function initializeCapacitorBridge() {
    window.Eliza = createBridge();
    // Dispatch an event to notify that the bridge is ready
    dispatchAppEvent(BRIDGE_READY_EVENT, window.Eliza);
}
/**
 * Wait for the bridge to be ready
 *
 * Returns immediately if already initialized, otherwise waits for the event.
 */
export function waitForBridge() {
    if (window.Eliza) {
        return Promise.resolve(window.Eliza);
    }
    return new Promise((resolve) => {
        document.addEventListener(BRIDGE_READY_EVENT, (event) => {
            resolve(event.detail);
        }, { once: true });
    });
}
