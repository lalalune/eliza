/**
 * Plugin Bridge
 *
 * This module provides a single interface to all Capacitor plugins
 * with platform-specific fallbacks and capability detection.
 *
 * When a native plugin is unavailable, it provides graceful degradation
 * to web APIs or capability-limited implementations where possible.
 */
import { Capacitor } from "@capacitor/core";
import { isElectrobunRuntime } from "./electrobun-runtime";
import { getCameraPlugin, getCanvasPlugin, getContactsPlugin, getDesktopPlugin, getGatewayPlugin, getLocationPlugin, getMessagesPlugin, getPhonePlugin, getScreenCapturePlugin, getSwabblePlugin, getSystemPlugin, getTalkModePlugin, } from "./native-plugins";
// Platform detection
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const _isIOS = platform === "ios";
const _isAndroid = platform === "android";
function isDesktopPlatform() {
    return isElectrobunRuntime();
}
function _isWebPlatform() {
    return platform === "web" && !isElectrobunRuntime();
}
function _isMacOSPlatform() {
    return isDesktopPlatform();
}
/**
 * Get plugin capabilities for the current platform
 */
export function getPluginCapabilities() {
    const isDesktop = isDesktopPlatform();
    return {
        gateway: {
            available: true, // Web fallback available
            discovery: isNative, // Discovery requires native APIs
            websocket: true, // WebSocket available on all platforms
        },
        voiceWake: {
            available: isNative || hasWebSpeechAPI(),
            continuous: isNative, // Only native supports continuous listening
        },
        talkMode: {
            available: isNative || hasWebSpeechAPI(),
            elevenlabs: true, // Web app can call ElevenLabs directly with user API key
            systemTts: isNative || hasWebSpeechSynthesis(),
        },
        camera: {
            available: isNative || hasMediaDevices(),
            photo: isNative || hasMediaDevices(),
            video: isNative || hasMediaDevices(),
        },
        location: {
            available: hasGeolocation(),
            gps: isNative,
            background: isNative && !isDesktop,
        },
        screenCapture: {
            available: isNative || hasDisplayMedia(),
            screenshot: isNative,
            recording: isNative || hasDisplayMedia(),
        },
        canvas: {
            available: true, // HTML Canvas available on all platforms
        },
        phone: {
            available: isNative && platform === "android",
        },
        contacts: {
            available: isNative && platform === "android",
        },
        messages: {
            available: isNative && platform === "android",
        },
        system: {
            available: isNative && platform === "android",
        },
        desktop: {
            available: isDesktop,
            tray: isDesktop,
            shortcuts: isDesktop,
            menu: isDesktop,
        },
    };
}
// Web API detection helpers
function hasWebSpeechAPI() {
    return (typeof window !== "undefined" &&
        ("SpeechRecognition" in window || "webkitSpeechRecognition" in window));
}
function hasWebSpeechSynthesis() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
}
function hasMediaDevices() {
    return (typeof navigator !== "undefined" &&
        "mediaDevices" in navigator &&
        "getUserMedia" in navigator.mediaDevices);
}
function hasGeolocation() {
    return typeof navigator !== "undefined" && "geolocation" in navigator;
}
function hasDisplayMedia() {
    return (typeof navigator !== "undefined" &&
        "mediaDevices" in navigator &&
        "getDisplayMedia" in navigator.mediaDevices);
}
/**
 * Create a wrapped plugin with error handling
 */
function wrapPlugin(plugin, _name) {
    return new Proxy(plugin, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value === "function") {
                return (...args) => value.apply(target, args);
            }
            return value;
        },
    });
}
// Singleton instance
let pluginsInstance = null;
/**
 * Initialize and get the plugins interface
 */
export function getPlugins() {
    if (pluginsInstance) {
        if (pluginsInstance.desktop.isNative === isDesktopPlatform()) {
            return pluginsInstance;
        }
    }
    const capabilities = getPluginCapabilities();
    const isDesktop = isDesktopPlatform();
    pluginsInstance = {
        gateway: {
            plugin: wrapPlugin(getGatewayPlugin(), "Gateway"),
            isNative: isNative,
            hasFallback: true,
        },
        swabble: {
            plugin: wrapPlugin(getSwabblePlugin(), "Swabble"),
            isNative: isNative,
            hasFallback: capabilities.voiceWake.available,
        },
        talkMode: {
            plugin: wrapPlugin(getTalkModePlugin(), "TalkMode"),
            isNative: isNative,
            hasFallback: capabilities.talkMode.available,
        },
        camera: {
            plugin: wrapPlugin(getCameraPlugin(), "Camera"),
            isNative: isNative,
            hasFallback: capabilities.camera.available,
        },
        location: {
            plugin: wrapPlugin(getLocationPlugin(), "Location"),
            isNative: isNative,
            hasFallback: capabilities.location.available,
        },
        screenCapture: {
            plugin: wrapPlugin(getScreenCapturePlugin(), "ScreenCapture"),
            isNative: isNative,
            hasFallback: capabilities.screenCapture.available,
        },
        canvas: {
            plugin: wrapPlugin(getCanvasPlugin(), "Canvas"),
            isNative: isNative,
            hasFallback: true,
        },
        phone: {
            plugin: wrapPlugin(getPhonePlugin(), "ElizaPhone"),
            isNative: isNative,
            hasFallback: capabilities.phone.available,
        },
        contacts: {
            plugin: wrapPlugin(getContactsPlugin(), "ElizaContacts"),
            isNative: isNative,
            hasFallback: capabilities.contacts.available,
        },
        messages: {
            plugin: wrapPlugin(getMessagesPlugin(), "ElizaMessages"),
            isNative: isNative,
            hasFallback: capabilities.messages.available,
        },
        system: {
            plugin: wrapPlugin(getSystemPlugin(), "ElizaSystem"),
            isNative: isNative,
            hasFallback: capabilities.system.available,
        },
        desktop: {
            plugin: wrapPlugin(getDesktopPlugin(), "Desktop"),
            isNative: isDesktop,
            hasFallback: false,
        },
        capabilities,
    };
    return pluginsInstance;
}
/**
 * Check if a specific plugin feature is available
 */
export function isFeatureAvailable(feature) {
    const caps = getPluginCapabilities();
    switch (feature) {
        case "gatewayDiscovery":
            return caps.gateway.discovery;
        case "voiceWake":
            return caps.voiceWake.available;
        case "talkMode":
            return caps.talkMode.available;
        case "elevenlabs":
            return caps.talkMode.elevenlabs;
        case "camera":
            return caps.camera.available;
        case "location":
            return caps.location.available;
        case "backgroundLocation":
            return caps.location.background;
        case "screenCapture":
            return caps.screenCapture.available;
        case "phone":
            return caps.phone.available;
        case "contacts":
            return caps.contacts.available;
        case "messages":
            return caps.messages.available;
        case "system":
            return caps.system.available;
        case "desktopTray":
            return caps.desktop.tray;
        default:
            return false;
    }
}
