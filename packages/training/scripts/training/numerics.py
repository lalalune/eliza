"""Fail-closed numerical checks shared by the Eliza-1 training entrypoints.

The helpers here keep loss finiteness, checkpoint tensor scans, dtype
resolution, Liger architecture gating, and APOLLO group-count checks in one
place so the local trainer and pipeline abort for the same reasons.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


class TrainingNumericsError(RuntimeError):
    """Base class for hard numerical safety gate failures."""


class LossNumericsError(TrainingNumericsError):
    """Raised when a trainer step returns a non-finite loss."""


class CheckpointNumericsError(TrainingNumericsError):
    """Raised when a saved checkpoint contains a non-finite tensor."""


class LigerCompatibilityError(TrainingNumericsError):
    """Raised when Liger is requested for an unsupported architecture."""


@dataclass(frozen=True)
class TrainDType:
    name: str
    torch_dtype: Any
    bf16: bool
    fp16: bool


@dataclass
class CheckpointScanReport:
    checkpoint_dir: str
    files: int = 0
    tensors: int = 0
    floating_tensors: int = 0
    floating_elements: int = 0
    failures: list[dict[str, str]] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.failures

    def to_dict(self) -> dict[str, Any]:
        return {
            "checkpoint_dir": self.checkpoint_dir,
            "files": self.files,
            "tensors": self.tensors,
            "floating_tensors": self.floating_tensors,
            "floating_elements": self.floating_elements,
            "passed": self.passed,
            "failures": self.failures,
        }


_LIGER_SUPPORTED_MODEL_TYPES = frozenset(
    {
        "gemma",
        "gemma2",
        "llama",
        "mistral",
        "mixtral",
        "mllama",
        "phi3",
        "qwen2",
        "qwen2_vl",
        "qwen3",
    }
)


def assert_finite_loss(loss: Any, *, stage: str = "train") -> None:
    """Raise if `loss` is NaN or Inf."""

    import torch

    if not torch.is_tensor(loss):
        raise LossNumericsError(f"{stage} loss is not a tensor: {type(loss).__name__}")
    finite = torch.isfinite(loss.detach()).all()
    if bool(finite.item()):
        return
    value = loss.detach().float().cpu()
    raise LossNumericsError(f"{stage} loss is non-finite: {value.item()!r}")


def resolve_train_dtype(dtype_name: str, device: str, torch_module: Any) -> TrainDType:
    """Resolve registry dtype into model dtype plus Trainer precision flags."""

    normalized = dtype_name.strip().lower()
    if normalized not in {"bf16", "fp16", "fp32", "float32", "fp8"}:
        raise TrainingNumericsError(
            f"unsupported train_dtype={dtype_name!r}; expected bf16, fp16, fp32, or fp8"
        )
    if normalized == "float32":
        normalized = "fp32"
    if normalized == "fp8":
        if device != "cuda":
            raise TrainingNumericsError("train_dtype=fp8 requires CUDA")
        if not (
            getattr(torch_module.cuda, "is_available", lambda: False)()
            and (
                # train_local.py gates the actual Transformer Engine swap.
                # This guard prevents future fp8 registry entries from
                # silently running as bf16 when the operator did not enable it.
                os.environ.get("ELIZA_FP8_TRAIN") == "1"
                or os.environ.get("ELIZA_DISABLE_FP8") != "1"
            )
        ):
            raise TrainingNumericsError("train_dtype=fp8 declared but FP8 is unavailable")
        return TrainDType("fp8", torch_module.bfloat16, bf16=False, fp16=False)
    if normalized == "fp16":
        if device != "cuda":
            raise TrainingNumericsError("train_dtype=fp16 requires CUDA")
        return TrainDType("fp16", torch_module.float16, bf16=False, fp16=True)
    if normalized == "bf16":
        if device == "cuda":
            return TrainDType("bf16", torch_module.bfloat16, bf16=True, fp16=False)
        if device == "mps":
            return TrainDType("bf16", torch_module.bfloat16, bf16=False, fp16=False)
        return TrainDType("bf16", torch_module.float32, bf16=False, fp16=False)
    return TrainDType("fp32", torch_module.float32, bf16=False, fp16=False)


def model_type_for_liger(model: Any) -> str:
    """Return the normalized HF model_type used for Liger allowlist checks."""

    config = getattr(model, "config", None)
    model_type = getattr(config, "model_type", None)
    return str(model_type or "").strip().lower()


def validate_liger_architecture(model: Any) -> str:
    """Require an architecture known to have matching Liger kernels."""

    model_type = model_type_for_liger(model)
    if model_type in _LIGER_SUPPORTED_MODEL_TYPES:
        return model_type
    raise LigerCompatibilityError(
        "Liger requested for unsupported model_type="
        f"{model_type or '<missing>'!r}; known-good types are "
        f"{', '.join(sorted(_LIGER_SUPPORTED_MODEL_TYPES))}. "
        "Disable Liger or add a Gemma-4-specific patch before training."
    )


def assert_liger_patch_markers(model: Any) -> None:
    """Catch the obvious no-op case after Liger monkey-patching."""

    for module in model.modules():
        module_name = type(module).__module__
        if module_name.startswith("liger_kernel"):
            return
    loss_fn = getattr(model, "loss_function", None)
    if loss_fn is not None and "liger" in type(loss_fn).__module__.lower():
        return
    raise LigerCompatibilityError(
        "Liger apply completed but no Liger module/loss markers were visible; "
        "refusing to continue because this looks like a no-op patch."
    )


def assert_apollo_lowrank_routing(
    *,
    expected_lowrank_names: Iterable[str],
    observed_lowrank_count: int,
    target_name: str,
) -> None:
    """Fail when FSDP wrapping loses APOLLO's pre-wrap 2-D parameter routing."""

    expected = len(set(expected_lowrank_names))
    if observed_lowrank_count == expected:
        return
    raise TrainingNumericsError(
        "APOLLO lowrank routing drift after wrapping: "
        f"expected {expected} projected tensors, got {observed_lowrank_count} "
        f"on {target_name}. This would route 2-D weights into the unprojected "
        "group, so the run is aborted."
    )


def _iter_tensors(obj: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    import torch

    if torch.is_tensor(obj):
        yield prefix or "<tensor>", obj
    elif isinstance(obj, dict):
        for key, value in obj.items():
            child = f"{prefix}.{key}" if prefix else str(key)
            yield from _iter_tensors(value, child)
    elif isinstance(obj, (list, tuple)):
        for index, value in enumerate(obj):
            child = f"{prefix}[{index}]" if prefix else f"[{index}]"
            yield from _iter_tensors(value, child)


def _tensor_files(checkpoint_dir: Path) -> list[Path]:
    patterns = (
        "*.safetensors",
        "pytorch_model*.bin",
        "adapter_model*.bin",
        "model*.bin",
        "*.pt",
        "*.pth",
    )
    files: list[Path] = []
    for pattern in patterns:
        files.extend(checkpoint_dir.rglob(pattern))
    return sorted({path for path in files if path.is_file()})


def _load_tensor_file(path: Path) -> dict[str, Any]:
    if path.suffix == ".safetensors":
        from safetensors.torch import load_file

        return load_file(str(path), device="cpu")

    import torch

    loaded = torch.load(str(path), map_location="cpu", weights_only=False)
    return loaded if isinstance(loaded, dict) else {"<root>": loaded}


def scan_checkpoint_tensors(checkpoint_dir: Path | str) -> CheckpointScanReport:
    """Scan checkpoint tensor files and raise on any NaN/Inf weight."""

    import torch

    root = Path(checkpoint_dir)
    if not root.is_dir():
        raise CheckpointNumericsError(f"checkpoint dir not found: {root}")

    report = CheckpointScanReport(checkpoint_dir=str(root))
    tensor_files = _tensor_files(root)
    if not tensor_files:
        raise CheckpointNumericsError(f"no tensor files found under checkpoint dir: {root}")

    for path in tensor_files:
        report.files += 1
        payload = _load_tensor_file(path)
        for name, tensor in _iter_tensors(payload):
            report.tensors += 1
            if not (torch.is_floating_point(tensor) or torch.is_complex(tensor)):
                continue
            report.floating_tensors += 1
            report.floating_elements += int(tensor.numel())
            finite = torch.isfinite(tensor).all()
            if not bool(finite.item()):
                report.failures.append({"file": str(path), "tensor": name})

    if report.failures:
        failures = ", ".join(
            f"{Path(item['file']).name}:{item['tensor']}" for item in report.failures[:5]
        )
        more = "" if len(report.failures) <= 5 else f" (+{len(report.failures) - 5} more)"
        raise CheckpointNumericsError(
            f"checkpoint numerics scan failed for {root}: {failures}{more}"
        )
    return report
