export const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";
export const MOBILE_LOCAL_AGENT_API_BASE = "http://127.0.0.1:2138";
export const MOBILE_LOCAL_AGENT_IPC_BASE = "eliza-local://agent";
export function readPersistedMobileRuntimeMode() {
  return null;
}
export function isMobileLocalAgentIpcUrl() {
  return false;
}
export function isMobileLocalAgentIpcBase() {
  return false;
}
export function isMobileLocalAgentUrl() {
  return false;
}
export function isElizaCloudRuntimeLocked() {
  return false;
}
