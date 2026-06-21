from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class RockySearchConfig:
    max_files_per_unit: int = 80
    max_units: int = 12
    max_manifest_entries: int = 200
    split_large_dirs: bool = True
    code_context_lines: int = 12
    docs_context_lines: int = 40
    log_context_lines: int = 60
    metrics_context_lines: int = 20
    max_evidence_block_lines: int = 80
    ignore_names: tuple[str, ...] = (
        ".git",
        ".hg",
        ".svn",
        ".pytest_cache",
        "__pycache__",
        "node_modules",
        "target",
        "dist",
        "build",
        ".venv",
    )
    ignore_suffixes: tuple[str, ...] = (
        ".pyc",
        ".pyo",
        ".so",
        ".dylib",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".pdf",
        ".zip",
        ".tar",
        ".gz",
    )
    priority_names: tuple[str, ...] = ("src", "rocky", "app", "lib", "tests", "docs")


def load_search_config(local_path: str | Path, config_path: str | Path | None = None) -> RockySearchConfig:
    path = _config_path(local_path, config_path)
    if path is None:
        return RockySearchConfig()
    data = json.loads(path.read_text())
    return _from_dict(data)


def _config_path(local_path: str | Path, config_path: str | Path | None) -> Path | None:
    if config_path:
        path = Path(config_path).expanduser().resolve()
        return path if path.exists() else None
    root = Path(local_path).expanduser().resolve()
    for name in ("rocky.json", ".rocky.json"):
        candidate = root / name
        if candidate.exists():
            return candidate
    return None


def _from_dict(data: dict[str, Any]) -> RockySearchConfig:
    defaults = RockySearchConfig()
    values: dict[str, Any] = {}
    for key in defaults.__dataclass_fields__:
        if key not in data:
            continue
        value = data[key]
        if isinstance(getattr(defaults, key), tuple):
            value = tuple(value)
        values[key] = value
    return RockySearchConfig(**values)
