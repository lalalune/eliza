/**
 * agent-surface types — the contract that makes every view element addressable,
 * focus-aware, fillable, and reactive to the agent.
 *
 * A view registers its interactive + informational elements through
 * `useAgentElement`. The registry exposes them to the agent via the standard
 * view-interact capabilities (`list-elements`, `agent-fill`, `agent-click`, …)
 * so the floating pill can drive any view from voice or text without the view
 * shipping its own chat surface.
 */
/** Roles the agent can type into. */
export const FILLABLE_ROLES = new Set([
    "text-input",
    "number-input",
    "textarea",
    "select",
    "slider",
]);
/** Roles the agent can activate (click). */
export const CLICKABLE_ROLES = new Set([
    "button",
    "link",
    "toggle",
    "tab",
    "menu-item",
    "list-item",
    "card",
]);
// Capability ids handled generically by the agent-surface registry. The
// canonical definition lives in @elizaos/shared so the agent server can dispatch
// against it without importing UI internals (#12408); re-exported here for the
// UI's agent-surface consumers.
export { AGENT_SURFACE_CAPABILITY_IDS } from "@elizaos/shared/views/view-interact-protocol";
