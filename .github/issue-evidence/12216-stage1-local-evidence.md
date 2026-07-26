# Stage 1 Corpus Hardening Local Evidence

Issue: #12318, part of #12216 Stage 1.
Captured: 2026-07-04T00:58:40Z.

## Commands run

```bash
bun run --cwd packages/scenario-runner test src/native-export.test.ts
```

Result: 17 passed.

```bash
uv run --project packages/training --with hypothesis --with pytest -- python -m pytest \
  packages/training/scripts/test_format_for_training.py \
  packages/training/scripts/test_format_for_training_privacy.py \
  packages/training/scripts/test_prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/test_validate_corpus.py \
  packages/training/scripts/test_validate_eliza1_trajectory_dataset.py
```

Result: 55 passed, 1 pytest config warning about `asyncio_mode`.

```bash
bun --conditions eliza-source --tsconfig-override ./tsconfig.json --eval '<synthetic trajectory export>'
rg -n 'sk-AbCdEfGhIj0123456789|ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa|37\.7749|48\.8566|REDACTED|privacy_attestation|redaction_count|residual_findings' \
  .github/issue-evidence/12216-stage1-native-export.jsonl \
  .github/issue-evidence/12216-stage1-native-export.manifest.json \
  .github/issue-evidence/12216-stage1-native-export.privacy-attestation.json
```

Result: exporter wrote 1 redacted native row with 4 redactions and 0 residuals.
Manual review confirmed the raw fake OpenAI key, fake GitHub token, and raw coordinate values do not appear in the exported JSONL.

```bash
uv run --project packages/training --with pytest -- python packages/training/scripts/validate_corpus.py \
  --input .github/issue-evidence/12216-stage1-native-export.jsonl \
  --report .github/issue-evidence/12216-stage1-native-export.validation-report.json \
  --strict
```

Result: 1 total, 1 valid, 0 invalid.

## Artifacts

- `.github/issue-evidence/12216-stage1-native-export.jsonl`
- `.github/issue-evidence/12216-stage1-native-export.manifest.json`
- `.github/issue-evidence/12216-stage1-native-export.privacy-attestation.json`
- `.github/issue-evidence/12216-stage1-native-export.validation-report.json`

## Not captured locally

- Live-model scenario trajectory: not captured in this forked workspace because no live model credential was used during this local slice.
- Screenshots/video/frontend logs: N/A, this change is non-UI corpus/tooling code.
- Full package typecheck: attempted with `bun run --cwd packages/scenario-runner typecheck`; it is blocked by pre-existing missing generated/shared workspace modules and unrelated UI/plugin type errors outside this slice.
