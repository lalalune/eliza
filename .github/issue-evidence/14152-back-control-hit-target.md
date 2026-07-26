# Evidence — real ≥44px back-control hit target + scoped ViewHeader sweep (#14152 / #14178 follow-up)

Follow-up landing the two holds from the #14178 review (lalalune, 18:0x–18:1xZ):
the back control's own box must satisfy the 44px tap minimum (no borrowing from
the header row), and the all-pages sweep must bind to the ROUTED view's header
(no ambient-header fallback).

## What changed
- `packages/ui/src/components/shared/ViewHeader.tsx` — `ViewBackButton` is now a
  44×44 hit target (`h-11 w-11 -m-1`) with the 36px visual chip moved to an
  inner span (`group-hover:bg-bg-hover`). Zero visual delta: the negative
  margin preserves the 36px layout footprint, the resting state stays
  chromeless, hover chip unchanged at 36px.
- `packages/app/test/ui-smoke/helpers/view-header.ts` — the tap-target check
  measures the BUTTON's own `boundingBox()` and requires ≥44px in BOTH
  dimensions; the row-borrowing `Math.max` is gone entirely. New `title`
  scoping option alongside `within`.
- `packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts` — every
  `requireViewHeader` route now scopes the assertion: `viewHeaderWithin` for
  the four shell-container routes (automations/wallet/settings/help),
  `viewHeaderTitle` for the two character deep-links (Skills/Experience).

## Evidence rows
- **Unit (structure + contract):** `bunx vitest run src/components/shared/ViewHeader.test.tsx`
  → **9/9 pass**, including the new pins: button `h-11 w-11 -m-1` (44px own-box
  hit target), chip on the inner span (`h-9 w-9`, `group-hover:bg-bg-hover`),
  rest state chromeless, icon-only. The old test pinned the chip ON the button;
  updated to pin the new two-layer structure explicitly.
- **Lint:** biome clean on all four files.
- **Sweep (mobile tap-target leg):** exercised by
  `all-pages-clicksafe.spec.ts` on the ≤500px viewport across the six
  `requireViewHeader` routes — runs in the `test:e2e` lane on this PR's CI; the
  new assertion fails against the pre-change 36px button by construction
  (button box < 44 in both dimensions, no fallback path).
- **Desktop/mobile screenshots:** N/A — zero-visual-delta change by design
  (layout footprint preserved via `-m-1`; hover chip identical). The unit pins
  + the measured-box e2e assertion are the behavioral proof; any visual drift
  would fail the existing aesthetic-audit baselines untouched by this PR.
- **Video walkthrough:** N/A — no flow change; the back control's behavior
  (click → navigate) is untouched and covered by `clickViewHeaderBack` specs.
- **Native/device capture:** N/A — web/desktop shared component; no native
  bridge or platform-conditional code touched. The 44px minimum this enforces
  IS the mobile-web guideline the sweep's mobile viewport leg asserts.
- **Real-LLM trajectories:** N/A — no agent/action/provider/prompt change
  (`useAgentElement` registration unchanged).
