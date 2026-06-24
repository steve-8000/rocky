from __future__ import annotations

from pathlib import Path

BLOCKED = (
    "codebase" + "-" + "memory" + "-" + "mcp",
    "codebase" + "_" + "memory",
    "Codebase" + "Memory",
    "ROCKY" + "_" + "CBM",
    "amaze" + "-" + "codebase",
)
SKIP_DIRS = {".git", ".venv", ".pytest_cache", "__pycache__", "vendor", "build", "rocky.egg-info", ".rocky"}


def test_rocky_source_uses_rocky_memory_and_rocky_codebase_names() -> None:
    root = Path(__file__).resolve().parents[1]
    offenders: list[str] = []
    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if not path.is_file():
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        if any(blocked in text for blocked in BLOCKED):
            offenders.append(str(path.relative_to(root)))
    assert offenders == []
