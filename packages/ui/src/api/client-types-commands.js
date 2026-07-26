/**
 * Transport types for the universal slash-command catalog served by
 * `GET /api/commands`. The wire contract is declared once in `@elizaos/shared`
 * (`SerializedCommand*`); the `SlashCommand*` names below are the UI-local
 * aliases the chat menu and client method use. Aliasing (not re-declaring) is
 * what keeps this surface from drifting off the shared contract (#12411).
 */
export {};
