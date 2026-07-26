# #13980 Mobile Cloud Sign-Out Affordance Evidence

## Change

Settings -> Cloud -> Overview now shows an inline Cloud account row whenever
Eliza Cloud is connected. The row exposes a dedicated `handleCloudSignOut`
account action through a visible `Sign out` button, so mobile cloud/cloud-hybrid
users can switch accounts without clearing app data or trying to disconnect the
required Cloud runtime.

## Verification

```bash
bunx @biomejs/biome check \
  packages/ui/src/state/useCloudState.ts \
  packages/ui/src/state/types.ts \
  packages/ui/src/state/AppContext.tsx \
  packages/ui/src/components/settings/CloudOverviewSection.tsx \
  packages/ui/src/components/settings/CloudOverviewSection.test.tsx \
  packages/ui/src/state/useCloudState.cloud-sign-out.test.tsx \
  .github/issue-evidence/13980-mobile-cloud-signout.md
```

Result: passed.

```bash
bunx vitest run \
  packages/ui/src/components/settings/CloudOverviewSection.test.tsx \
  packages/ui/src/state/useCloudState.cloud-sign-out.test.tsx
```

Result: passed, 2 test files / 4 tests.

```bash
git diff --check
```

Result: passed.

The focused test covers:

- connected Cloud sessions render `Cloud account` plus `Sign out`;
- clicking `Sign out` calls `handleCloudSignOut` instead of
  `handleCloudDisconnect`;
- disconnected Cloud sessions do not render the sign-out row;
- an in-flight disconnect disables the button and shows `Signing out...`.
- locked cloud runtime sign-out clears the Steward account session without
  calling `client.cloudDisconnect()`, and a stale post-sign-out cloud status
  poll does not flip the UI back to connected.

## Evidence Still Required Before Merge

- `bun run --cwd packages/app audit:app` with reviewed Settings -> Cloud output.
- Mobile full-page screenshot of Settings -> Cloud showing the account row.
- Mobile sign-out walkthrough video or screen recording.
- Console/network/native logs from a real signed-in mobile Cloud session proving
  account sign-out clears the session and the screen returns to the signed-out
  Cloud state.

These rows are intentionally left pending because this draft PR was prepared
from a code-review/fix worktree without a signed-in Seeker/mobile session.
