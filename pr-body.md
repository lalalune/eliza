# Relates to

Closes #16778.

- [x] This PR targets `develop` and is rebased onto the latest `origin/develop` with zero conflicts.
- [x] `bun install` and `bun run verify` were run after sync; unrelated upstream failures are recorded below.
- [x] A reviewer can confirm the fix from the focused and full Discord test evidence below.

# Sync with develop

- [x] Rebased onto `origin/develop` at `2113424424c`; zero conflicts.
- [x] The exact unrelated `bun run verify` blocker is documented in **Known gaps / failures**.

# Risks

Low. The change only alters the persistence context for Discord durable-turn memories. Existing turn state transitions and IDs are unchanged. A malformed legacy turn row without a world remains unreadable, which matches the prior behavior because the invalid foreign keys prevented those rows from being created successfully.

# Background

## What does this PR do?

It persists Discord durable-turn memories against the inbound message's established entity, room, and world instead of fabricating `entityId = agentId` and `roomId = turnId`.

The zero-key harness job failed all four Discord connector-loop cases before model generation because PostgreSQL rejected the fabricated memory foreign keys. The manager now computes the Discord world once, uses the same value for `ensureConnection`, and passes the real conversation scope into `claimDiscordTurn`.

## What kind of change is this?

Bug fix (non-breaking).

# Documentation changes needed?

N/A - the public configuration and connector behavior are unchanged; this repairs an internal persistence contract.

# Testing

## Where should a reviewer start?

Review the `claimDiscordTurn` call in `plugins/plugin-discord/messages.ts` and the persisted-context assertion in `plugins/plugin-discord/__tests__/turn-state.test.ts`.

## Detailed testing steps

```text
bun run --cwd plugins/plugin-discord test
Test Files  66 passed (66)
Tests       716 passed (716)

bun run --cwd plugins/plugin-discord test -- \
  __tests__/turn-state.test.ts \
  __tests__/messages-durable-turn.test.ts \
  __tests__/messages-inbound-idempotency.test.ts
Test Files  3 passed (3)
Tests       22 passed (22)

bun run --cwd plugins/plugin-discord typecheck
PASS

bunx biome check plugins/plugin-discord/turn-state.ts \
  plugins/plugin-discord/messages.ts \
  plugins/plugin-discord/__tests__/turn-state.test.ts
Checked 3 files. No fixes applied.
```

Original failing job: https://github.com/elizaOS/eliza/actions/runs/29918527641/job/88918516070

# Evidence Gate

<!-- evidence-row:before-screenshots -->
- [x] N/A - backend-only Discord memory persistence fix; no rendered UI surface changes.
<!-- evidence-row:after-screenshots -->
- [x] N/A - backend-only Discord memory persistence fix; no rendered UI surface changes.
<!-- evidence-row:walkthrough-video -->
- [x] N/A - no visual user flow changed; the affected path is the keyless connector harness.
<!-- evidence-row:backend-logs -->
- [x] N/A - no live Discord credentials are available in this environment; the linked failing Actions job and manually dispatched keyless harness provide the backend execution logs.
<!-- evidence-row:frontend-logs -->
- [x] N/A - no frontend code, console behavior, or network request changed.
<!-- evidence-row:llm-trajectory -->
- [x] N/A - no prompt, model, action, provider, or generated response behavior changed; the failure occurs before model generation.
<!-- evidence-row:domain-artifacts -->
- [x] N/A - no live Discord database is available; automated turn-state and manager tests inspect the persisted memory's entity, room, and world IDs directly.

# Evidence Details

## Real LLM-call trajectory

N/A - no LLM behavior changed, and the repaired failure is a pre-generation SQL persistence error.

## Backend + frontend logs

Backend failure evidence is in the linked Actions job. It records the rejected `discord_turns` insert with the fabricated turn ID as `room_id`, followed by zero outbound deliveries in all four cases.

Frontend: N/A - no frontend surface is involved.

## Screenshots (before / after) + video walkthrough

N/A - backend-only connector persistence fix with no UI changes.

## Audio / voice walkthrough

N/A - no voice, transcript, TTS, or STT behavior changed.

## Known gaps / failures

- `bun install --ignore-scripts --frozen-lockfile` fails on current `develop` because today's dependency merges changed dependency declarations without a matching frozen lockfile update.
- `bun run verify` stops at `check:biome-version`: current `develop` expects Biome 2.5.5 from the merged dependency group, while repository configs, templates, and lockfiles remain pinned to 2.5.4. This PR does not touch dependency or Biome files.
- The exact keyless harness cannot collect locally on macOS because Vitest resolves `zod` with an undefined named `z` export. The linked Linux CI job loaded the same harness successfully and reached the SQL failure; PR CI is the authoritative rerun. The full Discord unit suite, durability/idempotency tests, typecheck, and formatting all pass locally.
