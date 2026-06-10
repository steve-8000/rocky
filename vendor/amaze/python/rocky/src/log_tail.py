"""Operational log helpers for the Rocky service."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Tail at most this many bytes from the end of the log file. Caps work for any
# `limit`, even pathologically large ones, on a multi-MB rotating file.
_TAIL_MAX_BYTES = 2 * 1024 * 1024


def tail_jsonl(path: Path, *, limit: int) -> list[dict[str, Any]]:
    """Return up to `limit` JSON log records from the tail of `path` (oldest first).

    Lines that fail to parse are returned as `{"level": "RAW", "msg": <line>}`
    so a malformed final line never blanks the whole view.
    """
    if limit <= 0 or not path.exists():
        return []

    try:
        size = path.stat().st_size
    except OSError:
        return []
    if size == 0:
        return []

    read_size = min(size, _TAIL_MAX_BYTES)
    with path.open("rb") as fh:
        fh.seek(size - read_size)
        chunk = fh.read(read_size)

    # If we started mid-line, drop the partial leading line.
    if read_size < size:
        nl = chunk.find(b"\n")
        if nl == -1:
            return []
        chunk = chunk[nl + 1 :]

    lines = chunk.splitlines()
    out: list[dict[str, Any]] = []
    for raw in lines[-limit:]:
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                out.append(obj)
                continue
        except json.JSONDecodeError:
            pass
        out.append({"level": "RAW", "logger": "raw", "msg": line.decode("utf-8", errors="replace")})
    return out


__all__ = ["tail_jsonl"]
