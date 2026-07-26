export function normalizeRemoteAgentUrl(value) {
  return new URL(value).toString().replace(/\/+$/, "");
}
