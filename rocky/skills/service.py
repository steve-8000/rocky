from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


SKILL_TOOLS: list[dict] = [
    {
        "name": "skill_search",
        "description": (
            "Search reusable skills by semantic meaning. Returns name, summary, tags, and score; "
            "load the full body with skill_get when you want to use a matching skill."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Semantic search query for reusable skills."},
                "limit": {"type": "integer", "minimum": 1, "default": 5},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "skill_get",
        "description": "Load a reusable skill by name, including its summary, tags, body, and version.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Skill name to load."},
            },
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "skill_upsert",
        "description": "Create or update a reusable skill by writing its summary, tags, and markdown body.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Skill name to create or update."},
                "summary": {"type": "string", "description": "Short summary shown in search results."},
                "body": {"type": "string", "description": "Markdown body for the reusable skill."},
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional tags for filtering and fallback search.",
                },
            },
            "required": ["name", "summary", "body"],
            "additionalProperties": False,
        },
    },
    {
        "name": "skill_delete",
        "description": "Delete a reusable skill by name and remove its manifest entry.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Skill name to delete."},
            },
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "skill_list",
        "description": "List reusable skills by optional name prefix or required tags. Returns name, summary, and tags only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prefix": {"type": "string", "description": "Optional skill-name prefix filter."},
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional tags that every returned skill must include.",
                },
            },
            "additionalProperties": False,
        },
    },
]


class SkillsService:
    def __init__(self, codebase_client, skills_dir=None):
        default_dir = os.getenv("ROCKY_SKILLS_DIR") or "~/.rocky/skills"
        self.codebase_client = codebase_client
        self.skills_dir = Path(skills_dir or default_dir).expanduser()
        self.manifest_path = self.skills_dir / "manifest.json"

    def search(self, query: str, limit: int = 5) -> list[dict]:
        manifest = self._load_manifest()
        normalized_query = str(query or "").strip()
        normalized_limit = max(int(limit), 0)
        if normalized_limit <= 0 or not normalized_query:
            return []

        try:
            candidates = self.codebase_client.search_graph(
                normalized_query,
                self.skills_dir,
                limit=normalized_limit * 3,
            )
        except Exception:
            candidates = []

        if candidates:
            results_by_name: dict[str, dict[str, Any]] = {}
            for index, candidate in enumerate(candidates):
                candidate_name = Path(str(candidate.file_path)).name
                if candidate_name.endswith(".md"):
                    candidate_name = candidate_name[:-3]
                if candidate_name not in manifest:
                    continue
                score = candidate.rank if candidate.rank is not None else float((normalized_limit * 3) - index)
                current = results_by_name.get(candidate_name)
                if current is not None and current["score"] >= score:
                    continue
                entry = manifest[candidate_name]
                results_by_name[candidate_name] = {
                    "name": candidate_name,
                    "summary": str(entry.get("summary", "")),
                    "tags": self._normalize_tags(entry.get("tags")),
                    "score": score,
                }
            if results_by_name:
                return sorted(
                    results_by_name.values(),
                    key=lambda item: (-float(item["score"]), item["name"]),
                )[:normalized_limit]

        return self._fallback_search(normalized_query, normalized_limit, manifest)

    def get(self, name: str) -> dict:
        skill_name = self._sanitize_name(name)
        skill_path = self._skill_path(skill_name)
        if not skill_path.is_file():
            raise KeyError(skill_name)
        document = self._read_skill_file(skill_path)
        return {
            "name": skill_name,
            "summary": str(document.get("summary", "")),
            "tags": self._normalize_tags(document.get("tags")),
            "body": str(document.get("body", "")),
            "version": self._coerce_version(document.get("version")),
        }

    def upsert(self, name, summary, body, tags=None) -> dict:
        skill_name = self._sanitize_name(name)
        skill_path = self._skill_path(skill_name)
        normalized_tags = self._normalize_tags(tags)
        created = not skill_path.exists()
        version = 1
        if skill_path.exists():
            try:
                version = self._coerce_version(self._read_skill_file(skill_path).get("version")) + 1
            except Exception:
                manifest = self._load_manifest()
                version = self._coerce_version(manifest.get(skill_name, {}).get("version")) + 1

        payload = {
            "name": skill_name,
            "summary": str(summary),
            "tags": normalized_tags,
            "version": version,
        }

        self.skills_dir.mkdir(parents=True, exist_ok=True)
        skill_path.write_text(self._serialize_skill(payload, str(body)), encoding="utf-8")
        mtime = skill_path.stat().st_mtime

        manifest = self._load_manifest()
        manifest[skill_name] = {
            "summary": payload["summary"],
            "tags": normalized_tags,
            "version": version,
            "mtime": mtime,
        }
        self._write_manifest(manifest)

        try:
            self.codebase_client.index_repository(self.skills_dir)
        except Exception:
            pass

        return {"name": skill_name, "version": version, "created": created}

    def delete(self, name) -> dict:
        skill_name = self._sanitize_name(name)
        skill_path = self._skill_path(skill_name)
        deleted = False
        if skill_path.exists():
            skill_path.unlink()
            deleted = True

        manifest = self._load_manifest()
        if skill_name in manifest:
            manifest.pop(skill_name, None)
            deleted = True
            self._write_manifest(manifest)
        elif deleted and self.skills_dir.exists():
            self._write_manifest(manifest)

        return {"name": skill_name, "deleted": deleted}

    def list(self, prefix=None, tags=None) -> list[dict]:
        manifest = self._load_manifest()
        prefix_text = str(prefix) if prefix is not None else None
        required_tags = set(self._normalize_tags(tags)) if tags else None
        results: list[dict] = []
        for name in sorted(manifest):
            if prefix_text and not name.startswith(prefix_text):
                continue
            entry = manifest[name]
            entry_tags = self._normalize_tags(entry.get("tags"))
            if required_tags and not required_tags.issubset(set(entry_tags)):
                continue
            results.append(
                {
                    "name": name,
                    "summary": str(entry.get("summary", "")),
                    "tags": entry_tags,
                }
            )
        return results

    def dispatch(self, tool: str, arguments: dict) -> dict:
        payload = arguments or {}
        if tool == "skill_search":
            return self.search(**payload)
        if tool == "skill_get":
            return self.get(**payload)
        if tool == "skill_upsert":
            return self.upsert(**payload)
        if tool == "skill_delete":
            return self.delete(**payload)
        if tool == "skill_list":
            return self.list(**payload)
        raise ValueError(f"unknown skill tool: {tool}")

    def _skill_path(self, name: str) -> Path:
        return self.skills_dir / f"{name}.md"

    def _sanitize_name(self, name: str) -> str:
        skill_name = str(name or "").strip()
        if not skill_name or "/" in skill_name or "\\" in skill_name or ".." in skill_name:
            raise ValueError(f"invalid skill name: {name}")
        if not _NAME_PATTERN.fullmatch(skill_name):
            raise ValueError(f"invalid skill name: {name}")
        return skill_name

    def _load_manifest(self) -> dict[str, dict[str, Any]]:
        if not self.manifest_path.exists():
            return self._rebuild_manifest()
        try:
            data = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            return self._rebuild_manifest()
        if not isinstance(data, dict):
            return self._rebuild_manifest()

        manifest: dict[str, dict[str, Any]] = {}
        for name, entry in data.items():
            if not isinstance(name, str) or not isinstance(entry, dict):
                return self._rebuild_manifest()
            manifest[name] = {
                "summary": str(entry.get("summary", "")),
                "tags": self._normalize_tags(entry.get("tags")),
                "version": self._coerce_version(entry.get("version")),
                "mtime": float(entry.get("mtime", 0.0) or 0.0),
            }
        return manifest

    def _rebuild_manifest(self) -> dict[str, dict[str, Any]]:
        manifest: dict[str, dict[str, Any]] = {}
        if self.skills_dir.exists():
            for skill_path in sorted(self.skills_dir.glob("*.md")):
                try:
                    document = self._read_skill_file(skill_path)
                except Exception:
                    continue
                manifest[skill_path.stem] = {
                    "summary": str(document.get("summary", "")),
                    "tags": self._normalize_tags(document.get("tags")),
                    "version": self._coerce_version(document.get("version")),
                    "mtime": skill_path.stat().st_mtime,
                }
        self._write_manifest(manifest)
        return manifest

    def _write_manifest(self, manifest: dict[str, dict[str, Any]]) -> None:
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _read_skill_file(self, skill_path: Path) -> dict[str, Any]:
        text = skill_path.read_text(encoding="utf-8")
        frontmatter, body = self._parse_frontmatter(text)
        return {
            "name": str(frontmatter.get("name") or skill_path.stem),
            "summary": str(frontmatter.get("summary", "")),
            "tags": self._normalize_tags(frontmatter.get("tags")),
            "version": self._coerce_version(frontmatter.get("version")),
            "body": body,
        }

    def _parse_frontmatter(self, text: str) -> tuple[dict[str, Any], str]:
        lines = text.splitlines(keepends=True)
        if not lines or lines[0].strip() != "---":
            return {}, text
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                frontmatter_text = "".join(lines[1:index])
                body = "".join(lines[index + 1 :])
                data = self._yaml_load(frontmatter_text)
                return data if isinstance(data, dict) else {}, body
        return {}, text

    def _serialize_skill(self, frontmatter: dict[str, Any], body: str) -> str:
        return f"---\n{self._yaml_dump(frontmatter)}\n---\n{body}"

    def _yaml_load(self, content: str) -> dict[str, Any]:
        if yaml is not None:
            data = yaml.safe_load(content) or {}
            return data if isinstance(data, dict) else {}

        parsed: dict[str, Any] = {}
        current_key: str | None = None
        for raw_line in content.splitlines():
            line = raw_line.rstrip()
            if not line:
                continue
            if line.startswith("  - ") and current_key == "tags":
                parsed.setdefault("tags", []).append(line[4:].strip())
                continue
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip()
            current_key = key
            if not value:
                parsed[key] = [] if key == "tags" else ""
            elif key == "version":
                try:
                    parsed[key] = int(value)
                except ValueError:
                    parsed[key] = 1
            else:
                parsed[key] = value
        return parsed

    def _yaml_dump(self, data: dict[str, Any]) -> str:
        if yaml is not None:
            return yaml.safe_dump(data, sort_keys=False, allow_unicode=True).strip()

        lines: list[str] = []
        for key in ("name", "summary", "tags", "version"):
            value = data.get(key)
            if key == "tags":
                lines.append("tags:")
                for item in self._normalize_tags(value):
                    lines.append(f"  - {item}")
            else:
                lines.append(f"{key}: {value}")
        return "\n".join(lines)

    def _normalize_tags(self, tags: Any) -> list[str]:
        if tags is None:
            return []
        if isinstance(tags, str):
            tags = [tags]
        normalized: list[str] = []
        seen: set[str] = set()
        for tag in tags:
            value = str(tag).strip()
            if not value or value in seen:
                continue
            seen.add(value)
            normalized.append(value)
        return normalized

    def _coerce_version(self, value: Any) -> int:
        try:
            version = int(value)
        except (TypeError, ValueError):
            version = 1
        return max(version, 1)

    def _fallback_search(self, query: str, limit: int, manifest: dict[str, dict[str, Any]]) -> list[dict]:
        query_text = query.lower().strip()
        tokens = [token for token in re.split(r"\s+", query_text) if token]
        results: list[dict[str, Any]] = []
        for name, entry in manifest.items():
            summary = str(entry.get("summary", ""))
            tags = self._normalize_tags(entry.get("tags"))
            haystack = " ".join([name, summary, *tags]).lower()
            score = 0.0
            if query_text and query_text in haystack:
                score += float(len(query_text) + 5)
            score += float(sum(1 for token in tokens if token in haystack))
            if score <= 0:
                continue
            results.append(
                {
                    "name": name,
                    "summary": summary,
                    "tags": tags,
                    "score": score,
                }
            )
        return sorted(results, key=lambda item: (-float(item["score"]), item["name"]))[:limit]
