# Issue 11389 - Large-Tier Gemma Release Audit

Captured: 2026-07-03

## Current Hub State

Command:

```bash
curl -fsSL https://huggingface.co/api/models/elizaos/eliza-1
```

Manual review:

- Model repo sha: `a89e5615ad616f7bf6c4982cd9eed2805b90370f`
- Total files listed: `337`
- `bundles/9b/`: `0 files`
- `bundles/27b/`: `0 files`
- `bundles/27b-256k/`: `0 files`

This confirms the 9b, 27b, and 27b-256k Gemma release artifacts required by
issue #11389 are not present on the live model repository.

## Live Release Audit

Command:

```bash
/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 packages/training/scripts/manifest/audit_hf_eliza1_release.py --json
```

Exit code: `1`

Manual review of the JSON audit output:

- `9b bundle directory present`: failed, `0 files`
- `9b manifest present`: failed, `bundles/9b/eliza-1.manifest.json`
- `9b manifest JSON content available`: failed, Hub returned `HTTP 404`
- `27b bundle directory present`: failed, `0 files`
- `27b manifest present`: failed, `bundles/27b/eliza-1.manifest.json`
- `27b manifest JSON content available`: failed, Hub returned `HTTP 404`
- `27b-256k bundle directory present`: failed, `0 files`
- `27b-256k manifest present`: failed,
  `bundles/27b-256k/eliza-1.manifest.json`
- `27b-256k manifest JSON content available`: failed, Hub returned `HTTP 404`
- `catalog Eliza-1 publish status passed`: failed because
  `eliza-1-9b`, `eliza-1-27b`, and `eliza-1-27b-256k` are still `pending`
  instead of `published`

The audit also reports broader publishability gaps on the existing 2b/4b
bundles, including missing MTP release files and platform evidence. Those are
outside the named large-tier artifact gap, but they would still keep the full
release audit red.

## Local Guard Verification

Commands run:

```bash
PATH="/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm dlx @biomejs/biome check --write \
  plugins/plugin-local-inference/src/services/text-provenance.ts \
  plugins/plugin-local-inference/src/services/text-provenance.test.ts \
  plugins/plugin-local-inference/src/services/manifest/validator.ts \
  plugins/plugin-local-inference/src/services/manifest/manifest.test.ts

git diff --check

PATH="/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  NODE_OPTIONS="--experimental-sqlite" \
  /Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm dlx vitest run \
  --config /tmp/eliza-vitest-empty.config.mjs \
  plugins/plugin-local-inference/src/services/text-provenance.test.ts

/tmp/eliza-11389-pytest-venv/bin/python -m pytest \
  packages/training/scripts/manifest/test_audit_hf_eliza1_release.py \
  packages/training/scripts/manifest/test_eliza1_manifest.py \
  packages/training/scripts/manifest/test_stage_real_eliza1_bundle.py \
  packages/training/scripts/publish/test_publish_eliza1_model_repo.py \
  packages/training/scripts/publish/test_orchestrator.py \
  packages/training/scripts/publish/test_publish_eliza1_all.py -q
```

Results:

- Biome check passed for the touched TypeScript files.
- `git diff --check` passed.
- `text-provenance.test.ts`: `14 passed`.
- Training/publish Python tests: `214 passed`, with one existing pytest config
  warning for `asyncio_mode`.

Attempted but not runnable in this stripped worktree:

```bash
PATH="/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  NODE_OPTIONS="--experimental-sqlite" \
  /Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm dlx --package vitest --package zod vitest run \
  --config /tmp/eliza-vitest-empty.config.mjs \
  plugins/plugin-local-inference/src/services/manifest/manifest.test.ts
```

Result: failed before test collection because `zod` is not installed in this
worktree's dependency tree:

```text
Error: Cannot find package 'zod' imported from
plugins/plugin-local-inference/src/services/manifest/schema.ts
```

## Evidence Rows

- Real LLM trajectory: N/A - validator and release audit code only.
- UI screenshots/video/frontend logs: N/A - no UI code changed.
- Backend logs: N/A - no server runtime path changed.
- Domain artifact: live Hugging Face model repository audit above.

## Conclusion

The local gates now fail closed on manifest-declared production text GGUF bytes,
including `base-v1` manifests that are not default-eligible. The issue itself
cannot be completed from this checkout because the required live Gemma artifacts
for 9b, 27b, and 27b-256k are still absent from `elizaos/eliza-1`, and the
catalog entries for those tiers remain pending.
