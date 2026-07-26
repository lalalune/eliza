"""Stage 2 training-numerics gates for loss, checkpoint, dtype, and routing.

These tests are CPU-only and exercise the same helpers used by
`train_local.py` and `run_pipeline.py` so NaN loss, NaN checkpoint, unsupported
Liger architecture, and APOLLO/FSDP routing drift all fail closed.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import torch
from safetensors.torch import save_file

from scripts.training.model_registry import get
from scripts.training.numerics import (
    CheckpointNumericsError,
    LigerCompatibilityError,
    LossNumericsError,
    TrainingNumericsError,
    assert_apollo_lowrank_routing,
    assert_finite_loss,
    resolve_train_dtype,
    scan_checkpoint_tensors,
    validate_liger_architecture,
)


def test_assert_finite_loss_accepts_scalar_loss() -> None:
    assert_finite_loss(torch.tensor(0.25), stage="unit")


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_assert_finite_loss_rejects_nan_or_inf(bad: float) -> None:
    with pytest.raises(LossNumericsError, match="unit loss is non-finite"):
        assert_finite_loss(torch.tensor(bad), stage="unit")


def test_checkpoint_scan_passes_finite_safetensors(tmp_path) -> None:
    ckpt = tmp_path / "finite"
    ckpt.mkdir()
    save_file({"layer.weight": torch.ones(2, 3)}, str(ckpt / "model.safetensors"))

    report = scan_checkpoint_tensors(ckpt)

    assert report.passed is True
    assert report.files == 1
    assert report.floating_tensors == 1
    assert report.floating_elements == 6


def test_checkpoint_scan_rejects_nan_safetensors(tmp_path) -> None:
    ckpt = tmp_path / "nan"
    ckpt.mkdir()
    save_file(
        {"layer.weight": torch.tensor([[1.0, float("nan")]])},
        str(ckpt / "model.safetensors"),
    )

    with pytest.raises(CheckpointNumericsError, match="layer.weight"):
        scan_checkpoint_tensors(ckpt)


def test_checkpoint_scan_rejects_empty_checkpoint_dir(tmp_path) -> None:
    with pytest.raises(CheckpointNumericsError, match="no tensor files"):
        scan_checkpoint_tensors(tmp_path)


def test_registry_dtype_and_grad_clip_are_declared_per_tier() -> None:
    assert get("gemma4-e2b").train_dtype == "bf16"
    assert get("gemma4-e2b").max_grad_norm == pytest.approx(1.0)
    assert get("gemma4-e4b").max_grad_norm == pytest.approx(1.0)
    assert get("gemma4-12b").max_grad_norm == pytest.approx(0.5)
    assert get("gemma4-31b").max_grad_norm == pytest.approx(0.3)


def test_resolve_train_dtype_honors_bf16_on_cuda() -> None:
    dtype = resolve_train_dtype("bf16", "cuda", torch)
    assert dtype.name == "bf16"
    assert dtype.torch_dtype is torch.bfloat16
    assert dtype.bf16 is True
    assert dtype.fp16 is False


def test_resolve_train_dtype_honors_fp16_grad_scaler_path() -> None:
    dtype = resolve_train_dtype("fp16", "cuda", torch)
    assert dtype.name == "fp16"
    assert dtype.torch_dtype is torch.float16
    assert dtype.bf16 is False
    assert dtype.fp16 is True


def test_resolve_train_dtype_rejects_fp16_without_cuda() -> None:
    with pytest.raises(TrainingNumericsError, match="fp16 requires CUDA"):
        resolve_train_dtype("fp16", "cpu", torch)


def test_liger_allowlist_rejects_gemma4_until_a_real_patch_lands() -> None:
    model = SimpleNamespace(config=SimpleNamespace(model_type="gemma4"))
    with pytest.raises(LigerCompatibilityError, match="unsupported model_type='gemma4'"):
        validate_liger_architecture(model)


def test_liger_allowlist_accepts_known_good_architecture() -> None:
    model = SimpleNamespace(config=SimpleNamespace(model_type="gemma2"))
    assert validate_liger_architecture(model) == "gemma2"


def test_apollo_routing_count_matches_pre_wrap_names() -> None:
    assert_apollo_lowrank_routing(
        expected_lowrank_names={"model.layers.0.q_proj.weight", "model.layers.0.o_proj.weight"},
        observed_lowrank_count=2,
        target_name="TinyModel",
    )


def test_apollo_routing_count_mismatch_fails_closed() -> None:
    with pytest.raises(TrainingNumericsError, match="APOLLO lowrank routing drift"):
        assert_apollo_lowrank_routing(
            expected_lowrank_names={
                "model.layers.0.q_proj.weight",
                "model.layers.0.o_proj.weight",
            },
            observed_lowrank_count=1,
            target_name="FlatParameterWrapper",
        )
