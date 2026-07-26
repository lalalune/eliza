/**
 * Accessors for the Capacitor native plugins (agent, screen-capture, OCR, voice,
 * …) with permission-state typing, so renderer code reaches native features
 * through one typed surface.
 */
import { Capacitor } from "@capacitor/core";
function getCapacitorPlugins() {
    const capacitor = Capacitor;
    if (capacitor.Plugins) {
        return capacitor.Plugins;
    }
    if (typeof window !== "undefined") {
        const windowCapacitor = window.Capacitor;
        return windowCapacitor?.Plugins ?? {};
    }
    return {};
}
export function getNativePlugin(name) {
    return (getCapacitorPlugins()[name] ?? {});
}
export function getAgentPlugin() {
    const plugins = getCapacitorPlugins();
    return (plugins.Agent ??
        Capacitor.registerPlugin("Agent") ??
        {});
}
export function getElizaVoicePlugin() {
    return getNativePlugin("ElizaVoice");
}
export function getGatewayPlugin() {
    return getNativePlugin("Gateway");
}
export function getSwabblePlugin() {
    return getNativePlugin("Swabble");
}
export function getTalkModePlugin() {
    return getNativePlugin("TalkMode");
}
export function getLiveActivityPlugin() {
    return getNativePlugin("ElizaLiveActivity");
}
export function getMobileSignalsPlugin() {
    return getNativePlugin("MobileSignals");
}
export function getAppleCalendarPlugin() {
    return getNativePlugin("AppleCalendar");
}
export function getPushNotificationsPlugin() {
    return getNativePlugin("PushNotifications");
}
export function getAppBlockerPlugin() {
    const plugins = getCapacitorPlugins();
    return (plugins.ElizaAppBlocker ??
        plugins.AppBlocker ??
        {});
}
export function getCameraPlugin() {
    const plugins = getCapacitorPlugins();
    return (plugins.AppCamera ?? plugins.Camera ?? {});
}
export function getLocationPlugin() {
    return getNativePlugin("Location");
}
export function getScreenCapturePlugin() {
    return getNativePlugin("ScreenCapture");
}
export function getTesseractPlugin() {
    const plugins = getCapacitorPlugins();
    return (plugins.Tesseract ??
        plugins.ElizaTesseract ??
        {});
}
export function getCanvasPlugin() {
    return getNativePlugin("Canvas");
}
export function getDesktopPlugin() {
    return getNativePlugin("Desktop");
}
export function getWebsiteBlockerPlugin() {
    const plugins = getCapacitorPlugins();
    return (plugins.ElizaWebsiteBlocker ??
        plugins.WebsiteBlocker ??
        {});
}
export function getPhonePlugin() {
    return getNativePlugin("ElizaPhone");
}
export function getContactsPlugin() {
    return getNativePlugin("ElizaContacts");
}
export function getMessagesPlugin() {
    return getNativePlugin("ElizaMessages");
}
export function getSystemPlugin() {
    return getNativePlugin("ElizaSystem");
}
