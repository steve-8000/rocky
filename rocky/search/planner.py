from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .config import RockySearchConfig


@dataclass(frozen=True)
class ScopeUnit:
    path: str
    file_count: int
    reason: str


@dataclass(frozen=True)
class ScopePlan:
    root: Path
    total_files: int
    manifest: tuple[str, ...]
    units: tuple[ScopeUnit, ...]
    ignored: tuple[str, ...]


def plan_scope(local_path: str | Path, config: RockySearchConfig) -> ScopePlan:
    root = Path(local_path).expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"local path is not a directory: {root}")
    files = _list_files(root, root, config)
    manifest = tuple(_manifest(root, config))
    if len(files) <= config.max_files_per_unit:
        units = (ScopeUnit(".", len(files), "path fits within one FastContext unit"),)
    else:
        units = tuple(_split_units(root, config)[: config.max_units])
    return ScopePlan(root, len(files), manifest, units, tuple(sorted(set(config.ignore_names))))


def _split_units(root: Path, config: RockySearchConfig) -> list[ScopeUnit]:
    children = [child for child in sorted(root.iterdir()) if not _skip(root, child, config)]
    units: list[ScopeUnit] = []
    for directory in sorted([child for child in children if child.is_dir()], key=lambda path: _priority_key(path, config)):
        count = len(_list_files(root, directory, config))
        if count:
            units.append(ScopeUnit(directory.relative_to(root).as_posix(), count, "top-level scope unit"))
    root_files = [child for child in children if child.is_file() and not _skip(root, child, config)]
    if root_files:
        units.append(ScopeUnit(".", len(root_files), "root files scope unit"))
    return units or [ScopeUnit(".", 0, "empty path")]


def _manifest(root: Path, config: RockySearchConfig) -> list[str]:
    entries: list[str] = []
    for child in sorted(root.iterdir()):
        if _skip(root, child, config):
            continue
        entries.append(child.relative_to(root).as_posix() + ("/" if child.is_dir() else ""))
        if len(entries) >= config.max_manifest_entries:
            break
    return entries


def _list_files(root: Path, start: Path, config: RockySearchConfig) -> list[Path]:
    files: list[Path] = []
    for path in start.rglob("*") if start.is_dir() else [start]:
        if not _skip(root, path, config) and path.is_file():
            files.append(path)
    return files


def _skip(root: Path, path: Path, config: RockySearchConfig) -> bool:
    try:
        parts = set(path.relative_to(root).parts)
    except ValueError:
        return True
    return bool(parts & set(config.ignore_names)) or (path.is_file() and path.suffix in set(config.ignore_suffixes))


def _priority_key(path: Path, config: RockySearchConfig) -> tuple[int, str]:
    name = path.name.lower()
    priorities = tuple(item.lower() for item in config.priority_names)
    return (priorities.index(name) if name in priorities else len(priorities), path.as_posix())
