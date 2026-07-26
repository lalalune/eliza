# Stage 4 publish integrity evidence

Issue: #12321, parent epic #12216

## Scope exercised

- Manifest construction now reads `general.architecture` from GGUF bytes, records it on text files, derives tokenizer family from that byte-level source, and blocks publish-ready non-Gemma text GGUFs.
- Publish orchestration now binds recorded GPU verification and eval reports to the current commit and shipped text GGUF SHA-256s, requires device evidence, removes the eval alias bypass, and runs the live HF release audit after upload/final evidence promotion before tagging.
- Removed stale release bypass paths for Eliza-1 publish flow: runtime publish-status env override, per-tier `--allow-missing`, `--skip-hash-verify`, verification-queue `--summary-json`, wrapper forwarding of those flags, and legacy `--mode optimized` dispatch.
- Fixed the `27b-256k` orchestrator metadata KeyError path by adding its tagline and RAM budget.

## Commands run

```bash
python -m pytest packages/training/scripts/manifest/test_eliza1_manifest.py packages/training/scripts/manifest/test_audit_hf_eliza1_release.py packages/training/scripts/manifest/test_release_verification_queue.py packages/training/scripts/publish/test_orchestrator.py packages/training/scripts/publish/test_publish_eliza1_model_repo.py packages/training/scripts/publish/test_publish_model.py packages/training/scripts/test_emit_eliza1_catalog.py
```

Result: exit 0, `228 passed in 5.60s`.

```bash
python -m py_compile packages/training/scripts/manifest/eliza1_manifest.py packages/training/scripts/manifest/audit_hf_eliza1_release.py packages/training/scripts/manifest/stage_real_eliza1_bundle.py packages/training/scripts/manifest/stage_local_eliza1_bundle.py packages/training/scripts/manifest/release_verification_queue.py packages/training/scripts/emit_eliza1_catalog.py packages/training/scripts/sync_catalog_from_hf.py packages/training/scripts/publish/orchestrator.py packages/training/scripts/publish/publish_eliza1_model_repo.py packages/training/scripts/publish/publish_model.py packages/training/scripts/publish/stage_base_v1_candidate.py packages/training/scripts/publish/test_orchestrator.py
```

Result: exit 0.

```bash
node --check packages/training/scripts/publish/eliza1-hf-stage.mjs
```

Result: exit 0.

```bash
bash -n packages/training/scripts/publish/eliza1-hf-push.sh
```

Result: exit 0.

```bash
git diff --check -- <Stage 4 publish/integrity files>
```

Result: exit 0.

## Manual review notes

- Reviewed the issue body with `gh issue view 12321 --repo elizaOS/eliza --json title,body,labels,state,url` and matched the implementation to the Stage 4 checklist.
- Inspected the scoped diff for the publish/integrity files only. The worktree contains unrelated Stage 1/2/3, HF proxy, native, and app edits from other workers; those were left untouched.
- No screenshots, screen recordings, audio, or live-LLM trajectories apply to this CLI/publish-gate-only slice.

## Remaining real-world evidence blockers

- A live HF upload/audit was not run in this workspace because the user requested no push/PR and no production Hugging Face publish was performed here.
- `publish_all_eliza1.sh --filter-tier 27b-256k --dry-run` was not run against a full real 27b-256k release bundle in this workspace; the KeyError fix is covered by orchestrator metadata/tests rather than a production bundle transcript.
- Real qwen35 and Gemma release GGUFs were not downloaded for this run; byte-architecture behavior is covered by GGUF-header fixtures in the manifest and HF audit tests.
