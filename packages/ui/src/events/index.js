/**
 * Typed constants for eliza:* custom events dispatched across the app.
 *
 * The cross-platform event names + detail payloads + dispatch helpers live in
 * `@elizaos/shared/events` (the single source of truth, also consumed by the
 * server). This module re-exports them and adds the UI-only events that have no
 * server producer (focus-connector, voice-control, tutorial chat-control, and
 * the shared→dedicated cloud-agent handoff phases). The `Eliza*EventName` unions
 * here widen the shared unions with those UI-only events, so the local
 * `dispatchAppEvent` / `dispatchWindowEvent` accept them.
 */
export { 
// Agent / bridge
AGENT_READY_EVENT, APP_EMOTE_EVENT, APP_PAUSE_EVENT, 
// App state
APP_RESUME_EVENT, BRIDGE_READY_EVENT, CHAT_AVATAR_VOICE_EVENT, 
// App lifecycle
COMMAND_PALETTE_EVENT, CONNECT_EVENT, createNavigateViewEvent, 
// Shared dispatch helpers
dispatchAppEmoteEvent, dispatchElizaCloudStatusUpdated, dispatchNavigateViewEvent, ELIZA_CLOUD_STATUS_UPDATED_EVENT, EMOTE_PICKER_EVENT, FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT, MOBILE_RUNTIME_MODE_CHANGED_EVENT, NAVIGATE_VIEW_EVENT, NETWORK_STATUS_CHANGE_EVENT, 
// Sidebar sync
SELF_STATUS_SYNC_EVENT, SHARE_TARGET_EVENT, STOP_EMOTE_EVENT, TRAY_ACTION_EVENT, 
// Voice / config
VOICE_CONFIG_UPDATED_EVENT, 
// Avatar / VRM
VRM_TELEPORT_COMPLETE_EVENT, } from "@elizaos/shared/events";
export { useEmitViewEvent, useViewEvent } from "../hooks/useViewEvent";
export * from "../views/view-event-bus";
export * from "../views/view-event-types";
// ── UI-only events (no server producer) ──────────────────────────────────
export const FOCUS_CONNECTOR_EVENT = "eliza:focus-connector";
const FOCUS_CONNECTOR_STORAGE_KEY = "elizaos:focus-connector";
/**
 * A server-side agent action (START/STOP_TRANSCRIPTION) drives the shell's
 * transcription capture through this event: the `voice-control` agent-event
 * stream is re-dispatched here, and {@link useShellController} toggles the mic
 * accordingly. Keeps the agent→shell command decoupled (same pattern as the
 * tutorial/slash navigation events).
 */
export const VOICE_CONTROL_EVENT = "eliza:voice-control";
/** Dispatch a transcription start/stop command to the shell. */
export function dispatchVoiceControl(detail) {
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(VOICE_CONTROL_EVENT, { detail }));
}
// ── Shared → dedicated cloud-agent handoff ───────────────────────────────
/**
 * First-run provisions a personal cloud agent and lands the user in chat on the
 * shared REST adapter while the dedicated container boots; a background
 * supervisor then copies the conversation into the container and swaps the live
 * client over. That swap used to be silent (`.catch(() => {})`). This event is
 * the typed seam onto which the handoff's lifecycle is surfaced so chat-state /
 * a progress indicator can render it instead of the user seeing nothing.
 */
export const CLOUD_HANDOFF_PHASE_EVENT = "eliza:cloud-handoff-phase";
/**
 * Re-run a `timed-out`/`failed` shared→dedicated handoff for `agentId`. The
 * failure surface (banner) dispatches this when the user asks to retry; the
 * handoff runner that armed the retry re-invokes the (idempotent) supervisor,
 * so a transient container-boot failure isn't a silent permanent fallback.
 */
export const CLOUD_HANDOFF_RETRY_EVENT = "eliza:cloud-handoff-retry";
// ── Tutorial ─────────────────────────────────────────────────────────────
/**
 * The interactive tour drives the floating chat into a known state at the start
 * of each frame (and pre-fills the composer for the guided "ask to navigate"
 * demo) via this event; {@link ContinuousChatOverlay} applies it. Keeps the tour
 * decoupled from the overlay's internal detent state (same pattern as the slash
 * navigation events).
 */
export const TUTORIAL_CHAT_CONTROL_EVENT = "eliza:tutorial:chat-control";
export const CHAT_PREFILL_EVENT = "eliza:chat:prefill";
/**
 * Open (expand) the floating chat from anywhere — fired when the launcher's
 * "Messages" tile is tapped so landing on `/chat` lands the user IN an open
 * conversation, not on the wordless home with a collapsed pill. The always-
 * mounted {@link ContinuousChatOverlay} is the one listener.
 */
export const CHAT_OPEN_EVENT = "eliza:chat:open";
/** Open the keyword message-search panel (fired by the chat search affordance). */
export const CHAT_MESSAGE_SEARCH_EVENT = "eliza:chat:message-search";
/**
 * Open the notification center from anywhere (#10706). The notification center
 * is the dashboard widget (NotificationsHomeCenter) pinned on the home surface,
 * so this surface-agnostic window event — fired by the desktop-native
 * "Notifications" menu/tray item and the `<scheme>://notifications` deep link —
 * navigates to the home dashboard. The headless NotificationsShellBoot is the
 * one listener.
 */
export const OPEN_NOTIFICATION_CENTER_EVENT = "eliza:notifications:open";
/** Dispatch a tutorial chat-control instruction to the overlay. */
export function dispatchTutorialChatControl(detail) {
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(TUTORIAL_CHAT_CONTROL_EVENT, { detail }));
}
/** Dispatch a request to open the floating chat and prefill its composer. */
export function dispatchChatPrefill(detail) {
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(CHAT_PREFILL_EVENT, { detail }));
}
/** Dispatch a request to open (expand) the floating chat. See {@link CHAT_OPEN_EVENT}. */
export function dispatchChatOpen() {
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT));
}
/** Request the notification center to open (surface-agnostic — see
 * {@link OPEN_NOTIFICATION_CENTER_EVENT}). */
export function dispatchOpenNotificationCenter() {
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT));
}
// ── Android hardware back ─────────────────────────────────────────────────
/**
 * The Android hardware/gesture back press, surfaced to shell consumers BEFORE
 * the app's default back behavior runs (#9148). Native (`main.tsx`) dispatches
 * this on the Capacitor `backButton` event; a consumer with an open,
 * back-dismissable surface — today the {@link ContinuousChatOverlay} chat sheet
 * — closes ONE layer and flips `detail.handled = true`. The dispatcher reads
 * `handled` synchronously (custom events dispatch synchronously, so every
 * listener has run by the time `dispatchEvent` returns) and only falls through
 * to `history.back()` / `minimizeApp()` when nothing consumed the press. This
 * gives Android hardware-back the same "dismiss the open sheet first" behavior
 * desktop/web get from Escape. Web/desktop simply never dispatch it, so the
 * fall-through path is unchanged there.
 */
export const ELIZA_BACK_INTENT_EVENT = "eliza:back-intent";
/**
 * Dispatch the Android back-intent to shell consumers and report whether one of
 * them handled it (closed a surface). Returns `false` when nothing consumed the
 * press — including off-window (SSR) — so the caller can fall through to its
 * default back behavior. See {@link ELIZA_BACK_INTENT_EVENT}.
 */
export function dispatchBackIntent() {
    if (typeof window === "undefined")
        return false;
    const detail = { handled: false };
    window.dispatchEvent(new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }));
    return detail.handled;
}
// ── Helpers ──────────────────────────────────────────────────────────────
/** Dispatch a typed custom event on `document`. */
export function dispatchAppEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
}
/** Dispatch a typed custom event on `window`. */
export function dispatchWindowEvent(name, detail) {
    if (typeof window === "undefined")
        return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
}
/**
 * Surface a shared→dedicated handoff phase. Replaces the silent
 * `startCloudAgentHandoff(...).catch(() => {})` discard so the typed
 * {@link ConversationHandoffResult} reaches the UI.
 */
export function dispatchCloudHandoffPhase(detail) {
    dispatchWindowEvent(CLOUD_HANDOFF_PHASE_EVENT, detail);
}
/** Ask the armed handoff runner to retry a failed shared→dedicated handoff. */
export function dispatchCloudHandoffRetry(detail) {
    dispatchWindowEvent(CLOUD_HANDOFF_RETRY_EVENT, detail);
}
export function readPendingFocusConnector() {
    if (typeof window === "undefined")
        return null;
    try {
        const value = window.sessionStorage.getItem(FOCUS_CONNECTOR_STORAGE_KEY);
        return value && value.trim().length > 0 ? value : null;
    }
    catch {
        // error-policy:J3 storage unavailable — no pending focus hint; the
        // connectors page opens without a pre-focused entry.
        return null;
    }
}
export function clearPendingFocusConnector(connectorId) {
    if (typeof window === "undefined")
        return;
    try {
        if (connectorId) {
            const value = window.sessionStorage.getItem(FOCUS_CONNECTOR_STORAGE_KEY);
            if (value !== connectorId)
                return;
        }
        window.sessionStorage.removeItem(FOCUS_CONNECTOR_STORAGE_KEY);
    }
    catch {
        // Ignore storage failures; the event still drives the current page.
    }
}
export function dispatchFocusConnector(connectorId) {
    const normalized = connectorId.trim();
    if (!normalized)
        return;
    if (typeof window !== "undefined") {
        try {
            window.sessionStorage.setItem(FOCUS_CONNECTOR_STORAGE_KEY, normalized);
        }
        catch {
            // Ignore storage failures; the event still drives mounted listeners.
        }
    }
    dispatchAppEvent(FOCUS_CONNECTOR_EVENT, { connectorId: normalized });
}
