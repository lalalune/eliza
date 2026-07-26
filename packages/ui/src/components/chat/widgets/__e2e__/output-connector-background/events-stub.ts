export const BRIDGE_READY_EVENT = "eliza:bridge-ready";
export const CONNECT_EVENT = "eliza:connect";
export const MOBILE_RUNTIME_MODE_CHANGED_EVENT = "eliza:mobile-runtime-mode-changed";
export function dispatchAppEvent(name, detail) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
export function dispatchNavigateViewEvent(detail) {
  dispatchAppEvent("eliza:navigate:view", detail);
}
