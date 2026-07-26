# Issue 12319 Stage 2 Training Numerics Evidence

Date: 2026-07-04

Scope implemented in this workspace:

- `train_local.py` now fails closed on non-finite SFT loss.
- `train_local.py` honors registry `train_dtype` and per-tier `max_grad_norm`.
- `train_local.py` rejects unsupported Liger architectures instead of allowing
  a silent no-op patch.
- `train_local.py` checks APOLLO projected-group counts after wrapping.
- `train_local.py` writes `final/numerics_scan.json` after saving a finite
  checkpoint.
- `run_pipeline.py` runs the same checkpoint scan as a hard gate immediately
  after fine-tune, before benchmark/quantization.

Commands run and reviewed:

```bash
python -m pytest \
  packages/training/scripts/training/test_numerics.py \
  packages/training/scripts/test_train_local_low_vram_smoke.py \
  packages/training/scripts/test_train_local_stage2_smoke.py \
  packages/training/scripts/training/test_model_registry.py \
  packages/training/scripts/test_train_nebius_smoke_all_tiers.py::test_run_pipeline_skip_everything_exits_clean \
  packages/training/scripts/test_train_nebius_smoke_all_tiers.py::test_run_pipeline_accepts_max_steps_and_resume_via_source_inspection \
  -q
```

Observed result: `49 passed`. Warnings were unrelated pytest-asyncio loop-scope
and SWIG deprecation warnings.

```bash
python -m compileall -q \
  packages/training/scripts/train_local.py \
  packages/training/scripts/run_pipeline.py \
  packages/training/scripts/training/model_registry.py \
  packages/training/scripts/training/numerics.py \
  packages/training/scripts/training/test_numerics.py \
  packages/training/scripts/test_train_local_stage2_smoke.py
```

Observed result: exit 0.

Smoke artifact reviewed:

- `test_train_local_stage2_smoke.py` builds a tiny local Transformers causal LM,
  trains one real step through `train_local.py` against the tracked
  `packages/training/data/final-eliza1-smoke/` corpus, and asserts the emitted
  `final/numerics_scan.json` has `passed: true`, nonzero floating tensors, and
  nonzero floating elements.

Full Gemma/Liger evidence blocker:

- The issue's requested `gemma4-e2b --use-liger on` real smoke was not run in
  this workspace. The current host does not expose CUDA/H200-class hardware,
  and the new Liger allowlist intentionally rejects `model_type="gemma4"` until
  a Gemma-4-specific Liger patch is landed or upstream support is verified. The
  CPU-safe smoke proves the real `train_local.py` forward/backward/save/scan
  path, but it is not a replacement for the required hardware evidence before
  closing the issue.
