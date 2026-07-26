export const CONNECTOR_PLUGIN_MANAGED_MODE_ID = "plugin-managed";
export function normalizeConnectorCatalogId(id) {
  return String(id ?? "").replace(/^@elizaos\/plugin-/, "").replace(/^plugin-/, "");
}
