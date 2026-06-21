from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass
from pathlib import Path


class ToolError(ValueError):
    pass


@dataclass
class RepositoryTools:
    root: Path
    max_read_lines: int = 200
    max_matches: int = 50

    def __post_init__(self) -> None:
        self.root = self.root.expanduser().resolve()
        if not self.root.is_dir():
            raise ToolError(f"path is not a directory: {self.root}")

    def glob(self, pattern: str) -> str:
        matches = [
            self._rel(path)
            for path in sorted(self.root.rglob("*"))
            if path.is_file() and not self._skip(path) and fnmatch.fnmatch(self._rel(path), pattern)
        ][: self.max_matches]
        return "\n".join(matches) if matches else f"No files matched pattern: {pattern}"

    def grep(self, pattern: str, path: str = ".") -> str:
        regex = re.compile(pattern)
        start = self._resolve_inside_root(path)
        files = [start] if start.is_file() else [item for item in start.rglob("*") if item.is_file()]
        lines: list[str] = []
        for file_path in sorted(files):
            if self._skip(file_path):
                continue
            try:
                text = file_path.read_text(errors="replace")
            except OSError:
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    lines.append(f"{self._rel(file_path)}:{number}: {line}")
                    if len(lines) >= self.max_matches:
                        return "\n".join(lines)
        return f"No matches for pattern: {pattern}"

    def read(self, path: str, start_line: int = 1, end_line: int | None = None) -> str:
        target = self._resolve_inside_root(path)
        if not target.is_file():
            raise ToolError(f"READ path is not a file: {target}")
        lines = target.read_text(errors="replace").splitlines()
        start = max(1, start_line)
        end = min(len(lines), end_line or start + self.max_read_lines - 1)
        numbered = [f"{idx}: {lines[idx - 1]}" for idx in range(start, end + 1)]
        return f"{self._rel(target)} lines {start}-{end}\n" + "\n".join(numbered)

    def _resolve_inside_root(self, path: str) -> Path:
        path_obj = Path(path)
        candidate = path_obj.resolve() if path_obj.is_absolute() else (self.root / path_obj).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ToolError(f"path escapes repository root: {path}")
        if not candidate.exists():
            recovered = self._recover_unique_suffix(path)
            if recovered is not None:
                return recovered
        return candidate

    def _recover_unique_suffix(self, path: str) -> Path | None:
        path_obj = Path(path)
        if path_obj.is_absolute():
            try:
                suffix = path_obj.resolve().relative_to(self.root).as_posix()
            except ValueError:
                return None
        else:
            suffix = path.strip().lstrip("./")
        matches: list[Path] = []
        for candidate in self.root.rglob("*"):
            if candidate.is_file() and not self._skip(candidate):
                rel_path = self._rel(candidate)
                if rel_path == suffix or rel_path.endswith(f"/{suffix}"):
                    matches.append(candidate.resolve())
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            choices = ", ".join(self._rel(match) for match in matches[:8])
            raise ToolError(f"path is ambiguous: {path}; matching paths: {choices}")
        return None

    def _rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    def _skip(self, path: Path) -> bool:
        parts = set(path.relative_to(self.root).parts)
        return bool(parts & {".git", "__pycache__", ".pytest_cache", "node_modules", "target"})
