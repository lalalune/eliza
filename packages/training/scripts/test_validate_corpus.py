from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent))

from validate_corpus import run  # noqa: E402


def _attestation() -> dict[str, Any]:
    return {
        "schema": "eliza.privacy_filter_attestation.v1",
        "version": 1,
        "source": "unit",
        "redacted": True,
        "reviewed": True,
        "passed": True,
    }


def _native_row(*, text: str = "hello", attested: bool = True) -> dict[str, Any]:
    row = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "request": {"messages": [{"role": "user", "content": text}]},
        "response": {"text": "hi"},
        "metadata": {
            "task_type": "response",
            "source_dataset": "unit_native",
        },
    }
    if attested:
        row["metadata"]["privacy_attestation"] = _attestation()
    return row


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def test_validate_corpus_rejects_missing_native_privacy_attestation(
    tmp_path: Path,
) -> None:
    corpus = tmp_path / "native.jsonl"
    report = tmp_path / "report.json"
    _write_jsonl(corpus, [_native_row(attested=False)])

    code = run(corpus, report, strict=True, max_records=None)

    assert code == 1
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["invalid_records"] == 1
    assert (
        parsed["errors_by_task_type"]["response"][
            "native_v1_missing_privacy_attestation"
        ]
        == 1
    )


def test_validate_corpus_reports_duplicate_native_content_hash(
    tmp_path: Path,
) -> None:
    corpus = tmp_path / "native.jsonl"
    report = tmp_path / "report.json"
    _write_jsonl(corpus, [_native_row(), _native_row()])

    code = run(corpus, report, strict=False, max_records=None)

    assert code == 0
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["total_records"] == 2
    assert parsed["valid_records"] == 1
    assert parsed["invalid_records"] == 1
    assert parsed["errors_by_task_type"]["response"]["duplicate_content_hash"] == 1
    assert "duplicates line 1" in parsed["first_50_failing_records"][0]["fix_hint"]
