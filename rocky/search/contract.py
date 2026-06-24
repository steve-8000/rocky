from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Sequence

_MAX_LEXICAL_EVIDENCE = 5
_MAX_LEXICAL_FILES = 2500
_MAX_LEXICAL_FILE_BYTES = 512_000
_LEXICAL_CONTEXT_RADIUS = 3
_SKIP_DIRS = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
    "sessions",
}
_TEXT_EXTENSIONS = {
    ".c",
    ".cc",
    ".cfg",
    ".conf",
    ".cpp",
    ".css",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".prom",
    ".py",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}


def to_search_json(query: str, answer: str, repo: str | Path = ".") -> str:
    root = _normalize_root(repo)
    extracted = _extract_evidence(answer, root)
    if not extracted:
        extracted = _lexical_evidence(query, root)
    evidence = _filter_exact_blocks(_package_blocks(extracted, root), query)
    payload: dict[str, Any] = {
        "status": "ok",
        "query": query,
        "summary": _summary(answer, evidence),
        "evidence": evidence,
        "next_action": (
            "Use these exact file ranges first; avoid broad grep/ls unless snippets do not answer the task."
            if evidence
            else "No evidence found. Narrow the query or verify the local path."
        ),
    }
    return json.dumps(payload, indent=2)


def _extract_evidence(answer: str, root: Path) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    pattern = re.compile(r"(?P<path>[\w./-]+\.\w+):(?P<start>\d+)(?:-(?P<end>\d+))?")
    for match in pattern.finditer(answer):
        path = _normalize_path(match.group("path"), root)
        if path is None:
            continue
        start = int(match.group("start"))
        end = int(match.group("end") or start)
        evidence.append(
            {
                "path": path,
                "start_line": start,
                "end_line": end,
                "why": _reason(answer, path, start, end),
            }
        )
    return evidence


def _filter_exact_blocks(evidence: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    terms = _exact_terms(query)
    if not terms:
        return evidence
    matching = [item for item in evidence if any(term in str(item.get("snippet", "")) for term in terms)]
    return matching or evidence


def _exact_terms(query: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys([*re.findall(r"['\"]([^'\"]{4,})['\"]", query), *re.findall(r"\b[A-Z][A-Za-z0-9_]{7,}\b", query)]))


def _package_blocks(evidence: list[dict[str, Any]], root: Path) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in evidence:
        normalized = _normalize_path(str(item["path"]), root)
        if normalized is None:
            continue
        item["path"] = normalized
        grouped.setdefault(normalized, []).append(item)
    blocks: list[dict[str, Any]] = []
    for path, items in grouped.items():
        ordered = sorted(items, key=lambda item: (int(item["start_line"]), int(item["end_line"])))
        for group in _merge_nearby(ordered):
            start = min(int(item["start_line"]) for item in group)
            end = max(int(item["end_line"]) for item in group)
            kind = _kind(path)
            context_start, context_end = _context_window(root, path, start, end, kind)
            snippet = _snippet(root, path, context_start, context_end)
            if not snippet:
                continue
            blocks.append(
                {
                    "path": path,
                    "kind": kind,
                    "start_line": start,
                    "end_line": end,
                    "context_start_line": context_start,
                    "context_end_line": context_end,
                    "snippet": snippet,
                    "why": " | ".join(dict.fromkeys(str(item.get("why", "")).strip() for item in group if item.get("why")))[:500],
                    "source": "codebase",
                    "confidence": "high",
                }
            )
    return blocks[:8]


def _merge_nearby(items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    for item in items:
        start = int(item["start_line"])
        end = int(item["end_line"])
        if not groups:
            groups.append([item])
            continue
        current_start = min(int(existing["start_line"]) for existing in groups[-1])
        current_end = max(int(existing["end_line"]) for existing in groups[-1])
        if start <= current_end + 30 and max(end, current_end) - current_start <= 80:
            groups[-1].append(item)
        else:
            groups.append([item])
    return groups


def _kind(path: str) -> str:
    suffix = Path(path).suffix.lower()
    name = Path(path).name.lower()
    if suffix in {".log", ".out", ".err"} or "log" in name:
        return "log"
    if suffix in {".prom", ".metrics"} or name.endswith(".metrics.txt"):
        return "metrics"
    if suffix in {".md", ".markdown", ".rst", ".txt"}:
        return "document"
    if suffix in {".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env"}:
        return "config"
    return "code"


def _context_window(root: Path, rel_path: str, start: int, end: int, kind: str) -> tuple[int, int]:
    total = _line_count(root, rel_path)
    before, after, maximum = {"log": (60, 60, 140), "metrics": (20, 20, 60), "document": (40, 40, 120), "config": (15, 15, 50)}.get(kind, (12, 12, 80))
    context_start = max(1, start - before)
    context_end = min(total, end + after)
    if kind == "document":
        context_start, context_end = _document_section(root, rel_path, start, end, maximum)
    if context_end - context_start + 1 > maximum:
        context_end = context_start + maximum - 1
    return context_start, context_end


def _document_section(root: Path, rel_path: str, start: int, end: int, maximum: int) -> tuple[int, int]:
    lines = (root / rel_path).read_text(errors="replace").splitlines()
    section_start = start
    for index in range(start, 0, -1):
        if lines[index - 1].lstrip().startswith("#"):
            section_start = index
            break
    section_end = end
    for index in range(max(end + 1, section_start + 1), len(lines) + 1):
        if lines[index - 1].lstrip().startswith("#"):
            section_end = index - 1
            break
    return section_start, min(section_end, section_start + maximum - 1)


def _snippet(root: Path, rel_path: str, start: int, end: int) -> str:
    if not rel_path:
        return ""
    path = (root / rel_path).resolve()
    if root not in path.parents and path != root:
        return ""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(f"{idx}: {lines[idx - 1]}" for idx in range(max(1, start), min(len(lines), end) + 1))


def _line_count(root: Path, rel_path: str) -> int:
    try:
        return len((root / rel_path).read_text(errors="replace").splitlines())
    except OSError:
        return 0


def _normalize_path(raw_path: str, root: Path) -> str | None:
    path = _strip_host_prefix(Path(raw_path))
    if path.is_absolute():
        try:
            return path.resolve().relative_to(root).as_posix()
        except ValueError:
            recovered = _recover_unique_suffix(path.as_posix(), root)
            return recovered or path.as_posix()
    normalized_raw = path.as_posix()
    if (root / normalized_raw).exists():
        return normalized_raw
    return _recover_unique_suffix(normalized_raw, root) or normalized_raw


def _normalize_root(repo: str | Path) -> Path:
    original = Path(repo).expanduser()
    candidates = [_strip_host_prefix(original), original]
    seen: set[str] = set()

    for candidate in candidates:
        key = candidate.as_posix()
        if key in seen:
            continue
        seen.add(key)
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.exists():
            return resolved

    return candidates[0].resolve()


def _strip_host_prefix(path: Path) -> Path:
    raw = path.as_posix()
    if raw == "/host":
        return Path("/")
    if raw.startswith("/host/"):
        return Path(raw[len("/host") :])
    return path


def _recover_unique_suffix(raw_path: str, root: Path) -> str | None:
    suffix = raw_path.strip().lstrip("./").lstrip("/")
    matches = [path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file() and (path.relative_to(root).as_posix() == suffix or path.relative_to(root).as_posix().endswith(f"/{suffix}"))]
    return matches[0] if len(matches) == 1 else None


def _reason(answer: str, path: str, start: int, end: int) -> str:
    for line in answer.splitlines():
        if f"{path}:{start}" in line or f"{path}:{start}-{end}" in line:
            return line.strip("- •\t ")
    return f"{path}:{start}-{end}"


def _lexical_evidence(query: str, root: Path) -> list[dict[str, Any]]:
    if not root.exists():
        return []

    tokens = _query_tokens(query)
    if not tokens:
        return []
    path_hints = _query_path_hints(query)

    files = list(_iter_text_files(root))
    if path_hints:
        hinted_files = [path for path in files if _matches_query_path_hints(path.relative_to(root), path_hints)]
        if hinted_files:
            files = hinted_files

    matches: list[tuple[int, str, int, int, str]] = []
    scanned = 0
    for path in files:
        scanned += 1
        if scanned > _MAX_LEXICAL_FILES:
            break

        try:
            if path.stat().st_size > _MAX_LEXICAL_FILE_BYTES:
                continue
            lines = path.read_text(errors="ignore").splitlines()
        except OSError:
            continue

        joined = "\n".join(lines).lower()
        file_score = sum(1 for token in tokens if token in joined)
        path_text = path.relative_to(root).as_posix().lower()
        path_score = sum(1 for token in tokens if token in path_text)

        best_line: int | None = None
        best_score = 0
        best_text = ""
        for index, line in enumerate(lines, start=1):
            lowered = line.lower()
            score = sum(1 for token in tokens if token in lowered)
            if score > best_score:
                best_score = score
                best_line = index
                best_text = line.strip()

        total_score = best_score + file_score + (path_score * 3)
        if best_line is None or total_score == 0:
            continue

        relative = path.relative_to(root).as_posix()
        matches.append((total_score, relative, best_line, best_line, best_text))

    matches.sort(key=lambda item: (-item[0], len(item[1]), item[1], item[2]))
    return [
        {
            "path": relative,
            "start_line": max(1, start - _LEXICAL_CONTEXT_RADIUS),
            "end_line": end + _LEXICAL_CONTEXT_RADIUS,
            "why": best_text or f"{relative}:{start}",
        }
        for _, relative, start, end, best_text in matches[:_MAX_LEXICAL_EVIDENCE]
    ]


def _query_tokens(query: str) -> list[str]:
    stopwords = {
        "and",
        "for",
        "from",
        "how",
        "into",
        "need",
        "the",
        "this",
        "what",
        "when",
        "where",
        "why",
        "with",
    }
    tokens: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9_./:-]+", query.lower()):
        token = raw.strip("./:-")
        if len(token) < 3 or token in stopwords:
            continue
        tokens.append(token)
        for part in re.split(r"[/_.:-]+", token):
            if len(part) >= 3 and part not in stopwords:
                tokens.append(part)
    return sorted(set(tokens), key=lambda item: (-len(item), item))


def _query_path_hints(query: str) -> list[str]:
    hints: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9_./*-]+", query.lower()):
        token = raw.strip(".,:;()[]{}<>\"'")
        if len(token) < 3 or token.startswith(("http://", "https://")):
            continue
        if "/" not in token and "." not in token:
            continue
        normalized = token.replace("**/", "").replace("**", "").replace("*", "").strip("/")
        if len(normalized) < 3:
            continue
        if normalized not in hints:
            hints.append(normalized)
    return hints


def _matches_query_path_hints(relative_path: Path, hints: Sequence[str]) -> bool:
    relative_text = relative_path.as_posix().lower()
    relative_name = relative_path.name.lower()
    for hint in hints:
        normalized = hint.lower().strip("/")
        if not normalized:
            continue
        if "/" in normalized:
            if relative_text.endswith(normalized) or normalized in relative_text:
                return True
            continue
        if relative_name == normalized or relative_text.endswith(f"/{normalized}"):
            return True
    return False


def _iter_text_files(root: Path):
    if root.is_file():
        if _is_text_candidate(root):
            yield root
        return

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in _SKIP_DIRS for part in path.relative_to(root).parts[:-1]):
            continue
        if _is_text_candidate(path):
            yield path


def _is_text_candidate(path: Path) -> bool:
    return path.suffix.lower() in _TEXT_EXTENSIONS or path.name in {"Makefile", "Dockerfile"}


def _summary(answer: str, evidence: list[dict[str, Any]]) -> str:
    if evidence:
        return f"Found {len(evidence)} evidence block(s)."
    cleaned = re.sub(r"</?final_answer>", "", answer).strip()
    return cleaned[:500] if cleaned else "No evidence found."
