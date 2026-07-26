# 14187 build badge production gate evidence

## Scope

This fix keeps the tester-only BuildBadge stamp out of production renderer
builds even when the build path invokes Vite directly (`build:web`, Cloudflare
Pages, or a direct `vite build`) instead of `packages/app/scripts/build.mjs`.

## Verification

- `bun run --cwd packages/app test -- scripts/build.test.mjs` — 1 file / 5
  tests passed.
- `bunx @biomejs/biome check packages/app/scripts/build.mjs packages/app/scripts/build-stamp.mjs packages/app/scripts/build.test.mjs packages/app/vite.config.ts --write` — passed.
- `node --check packages/app/scripts/build.mjs && node --check packages/app/scripts/build-stamp.mjs` — passed.
- `git diff --check` — passed.
- `VITE_ENVIRONMENT=production ELIZA_DISABLE_WEB_SHELL=1 bun run --cwd packages/app build:web` with a deliberately stale `packages/app/public/build-info.json` present — passed after generating the shared i18n artifact required by this fresh worktree.
- Post-build file check: `packages/app/dist/build-info.json` absent and `packages/app/public/build-info.json` absent.
- Direct Vite production mode with no `VITE_ENVIRONMENT`: `ELIZA_DISABLE_WEB_SHELL=1 node ../../node_modules/@elizaos/vitest-vite/bin/vite.js build` from `packages/app` with a deliberately stale `public/build-info.json` present — passed; `dist/build-info.json` and `public/build-info.json` were both absent.
- Production preview at `http://127.0.0.1:4173/`: page status 200, `[data-testid="build-badge"]` count 0, full-page screenshot captured at `14187-build-badge-prod-gate.png`.
- Direct request to `/build-info.json` in Vite preview returned the SPA fallback HTML (`content-type: text/html`); the actual evidence is the absent dist/public files plus the DOM check showing the badge did not render.

## Evidence rows

- UI screenshots/video: screenshot attached; no video because this is a static
  absence check with no user flow.
- Frontend logs: Playwright console captured startup logs and expected 502s from
  the production preview without an API server; no BuildBadge render occurred.
- Backend logs: N/A - static renderer build and preview only.
- Real-LLM trajectories: N/A - no agent/model/prompt behavior changed.
- Audio/native/device artifacts: N/A - no audio/native/device behavior changed.
- Domain artifacts: N/A - no DB/memory/wallet/file-generation behavior changed.
