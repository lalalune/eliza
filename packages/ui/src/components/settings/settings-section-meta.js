/**
 * Canonical metadata for the built-in settings sections: id, English label, and
 * top-level group. Pure data (no React, no icons) so non-renderer consumers —
 * notably app-core's `dev-route-catalog` parity test — can import it and assert
 * the QA catalog never drifts from the UI without pulling the renderer graph.
 *
 * The React registry (`settings-sections.ts`) reads this list and attaches the
 * icon, medallion hue, and section component per id. This is the single source
 * of truth for built-in section ids, labels, and grouping.
 */
export const SETTINGS_GROUP_ORDER = [
    "agent",
    "system",
    "security",
];
export const SETTINGS_GROUP_LABEL = {
    agent: "Agent",
    system: "System",
    security: "Security",
};
/**
 * Display order is array order, bucketed by group. Keep new built-ins grouped
 * with their peers so the nav reads top-to-bottom the way it renders.
 */
export const SETTINGS_SECTION_META = [
    {
        id: "identity",
        defaultLabel: "Basics",
        group: "agent",
        aliases: ["basics", "profile"],
    },
    {
        id: "ai-model",
        defaultLabel: "Models & Providers",
        group: "agent",
        aliases: ["model", "models", "provider", "providers", "ai", "cloud"],
    },
    {
        id: "voice",
        defaultLabel: "Voice",
        group: "agent",
        aliases: ["tts", "speech"],
    },
    {
        id: "capabilities",
        defaultLabel: "Capabilities",
        group: "agent",
        aliases: ["abilities"],
    },
    { id: "apps", defaultLabel: "Apps", group: "agent", aliases: ["views"] },
    {
        id: "connectors",
        defaultLabel: "Connectors",
        group: "agent",
        aliases: ["connections", "integrations"],
    },
    { id: "runtime", defaultLabel: "Runtime", group: "system" },
    {
        id: "appearance",
        defaultLabel: "Appearance",
        group: "system",
        aliases: ["theme", "look"],
    },
    { id: "background", defaultLabel: "Background", group: "system" },
    {
        id: "remote-plugins",
        defaultLabel: "Remote Plugins",
        group: "system",
        aliases: ["remote"],
    },
    {
        id: "wallet-rpc",
        defaultLabel: "Wallet & RPC",
        group: "system",
        aliases: ["wallet", "rpc"],
    },
    {
        id: "updates",
        defaultLabel: "Updates",
        group: "system",
        aliases: ["update"],
    },
    {
        id: "advanced",
        defaultLabel: "Backup & Reset",
        group: "system",
        aliases: ["fine-tuning"],
    },
    { id: "app-permissions", defaultLabel: "App Permissions", group: "security" },
    {
        id: "permissions",
        defaultLabel: "Permissions",
        group: "security",
        aliases: ["perms"],
    },
    {
        id: "secrets",
        defaultLabel: "Vault",
        group: "security",
        aliases: ["vault", "keys"],
    },
    { id: "security", defaultLabel: "Security", group: "security" },
];
