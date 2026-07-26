# #13758 ChatSurface Choice Rendering Evidence

Supplemental follow-up for #13758 / #13796. The merged fix covered the first-run
fallback and `ChoiceWidget`; this follow-up covers the app shell `ChatSurface`
path, which rendered assistant `message.content` directly.

## Artifacts

- `chat-desktop-landscape.png`
- `chat-mobile-portrait.png`
- `chat-mobile-landscape.png`
- `chat-ipad-portrait.png`

All four screenshots were opened and manually reviewed. The `/chat` first-run
suggestion actions render as clickable pill controls; mobile wrapping is
acceptable and the composer does not overlap the prompt or actions.

## Checks

```bash
bun run --cwd packages/ui test \
  src/first-run/first-run-action-channel.test.ts \
  src/components/chat/widgets/interaction-widgets.behavior.test.tsx \
  src/components/shell/__tests__/ChatSurface.test.tsx \
  --run
```

Result: pass, 3 files / 42 tests.

```bash
bunx biome check \
  packages/ui/src/components/shell/ChatSurface.tsx \
  packages/ui/src/components/shell/__tests__/ChatSurface.test.tsx \
  packages/ui/src/first-run/first-run-action-channel.ts \
  packages/ui/src/first-run/first-run-action-channel.test.ts \
  packages/ui/src/state/AppContext.tsx \
  packages/ui/src/components/chat/widgets/interaction-widgets.behavior.test.tsx
```

Result: pass, 6 files checked.

```bash
git diff --check origin/develop...HEAD
```

Result: pass.

```bash
ELIZA_NODE_PATH="$HOME/.nvm/versions/node/v24.15.0/bin/node" \
  bun run --cwd packages/app audit:app
```

Result: failed on unrelated minimalism ratchet debt in
`plugin-hyperliquid-gui` and `plugin-polymarket-gui`. The four `builtin-chat`
variants passed:

- `builtin-chat mobile-portrait`
- `builtin-chat mobile-landscape`
- `builtin-chat desktop-landscape`
- `builtin-chat ipad-portrait`

The first audit attempt failed before browser coverage because the default
Homebrew `node` was 23.3.0; rerun used Node 24.15.0 via `ELIZA_NODE_PATH`.
