from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class CodeEvidence:
    evidence_id: str
    root: str
    file: str
    start_line: int
    end_line: int
    source: str
    score: float
    confidence: float
    matched_terms: tuple[str, ...] = ()
    symbol: str | None = None
    relation: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def key(self) -> tuple[str, int, int, str]:
        return (self.file, self.start_line, self.end_line, self.source)


def stable_id(prefix: str, payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return f"{prefix}_{hashlib.sha1(raw).hexdigest()[:16]}"


def file_revision(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def line_window(lines: list[str], line: int, desired: int = 12) -> tuple[int, int]:
    if not lines:
        return (1, 1)
    half = max(1, desired // 2)
    start = max(1, line - half)
    end = min(len(lines), start + desired - 1)
    start = max(1, end - desired + 1)
    return start, end


def snippet_for(path: Path, start_line: int, end_line: int) -> tuple[str, int]:
    lines = path.read_text(errors="replace").splitlines()
    if not lines:
        return "", 0
    start = max(1, min(start_line, len(lines)))
    end = max(start, min(end_line, len(lines)))
    selected = [f"{idx}: {lines[idx - 1]}" for idx in range(start, end + 1)]
    return _api_safe_text("\n".join(selected)), len(selected)


def _api_safe_text(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")
        .translate({codepoint: "" for codepoint in range(32) if codepoint not in {9, 10, 13}})
    )
