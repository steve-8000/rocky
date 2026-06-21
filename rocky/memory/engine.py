from __future__ import annotations

import json
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

ScopeKind = Literal["global", "project", "path"]


@dataclass(frozen=True)
class MemoryScope:
    kind: ScopeKind
    project_path: str | None = None
    path: str | None = None

    def key(self) -> str:
        if self.kind == "global":
            return "global"
        if not self.project_path:
            raise ValueError("project_path is required for project/path memory")
        project = _stable_path(self.project_path)
        if self.kind == "project":
            return f"project:{project}"
        if not self.path:
            raise ValueError("path is required for path memory")
        return f"path:{project}:{_stable_path(self.path)}"


@dataclass(frozen=True)
class MemoryFact:
    id: str
    scope: MemoryScope
    text: str
    source: str
    created_at: str
    updated_at: str
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class MemoryHit:
    fact: MemoryFact
    score: float


class MemoryEngine:
    """Xenonite-compatible durable memory store without a separate embedding model.

    This stage intentionally uses deterministic lexical/path recall. LLM-based
    classification/reranking is wired in the next integration stage through the
    shared FastContext runtime.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.store_path = self.root / "memory.jsonl"
        self.index_path = self.root / "canonical.json"

    def store(
        self,
        text: str,
        scope: MemoryScope,
        source: str = "verified_durable_fact",
        tags: tuple[str, ...] = (),
    ) -> MemoryFact:
        clean = " ".join(text.split())
        if not clean:
            raise ValueError("memory text must not be empty")
        facts = self._read_all()
        existing = self._find_duplicate(facts, clean, scope)
        now = _now()
        if existing is not None:
            updated = MemoryFact(
                id=existing.id,
                scope=existing.scope,
                text=existing.text,
                source=source or existing.source,
                tags=tuple(dict.fromkeys([*existing.tags, *tags])),
                created_at=existing.created_at,
                updated_at=now,
            )
            facts = [updated if fact.id == existing.id else fact for fact in facts]
        else:
            updated = MemoryFact(
                id=f"mem_{uuid.uuid4().hex[:16]}",
                scope=scope,
                text=clean,
                source=source,
                tags=tags,
                created_at=now,
                updated_at=now,
            )
            facts.append(updated)
        self._write_all(facts)
        return updated

    def recall(self, query: str, scope: MemoryScope, limit: int = 8) -> list[MemoryHit]:
        query_terms = _terms(query)
        hits: list[MemoryHit] = []
        for fact in self._read_all():
            if not _scope_visible(fact.scope, scope):
                continue
            score = _lexical_score(query_terms, fact)
            if score > 0:
                hits.append(MemoryHit(fact, score))
        return sorted(hits, key=lambda hit: (-hit.score, hit.fact.updated_at, hit.fact.id))[:limit]

    def delete(self, scope: MemoryScope, id: str | None = None, text: str | None = None, text_prefix: str | None = None) -> int:
        facts = self._read_all()
        kept: list[MemoryFact] = []
        deleted = 0
        for fact in facts:
            should_delete = _same_scope(fact.scope, scope) and (
                (id is not None and fact.id == id)
                or (text is not None and fact.text == text)
                or (text_prefix is not None and fact.text.startswith(text_prefix))
            )
            if should_delete:
                deleted += 1
            else:
                kept.append(fact)
        if deleted:
            self._write_all(kept)
        return deleted

    def optimize(self) -> dict[str, int]:
        facts = self._read_all()
        seen: set[tuple[str, str]] = set()
        optimized: list[MemoryFact] = []
        removed = 0
        for fact in facts:
            key = (fact.scope.key(), _canonical_text(fact.text))
            if key in seen:
                removed += 1
                continue
            seen.add(key)
            optimized.append(fact)
        if removed:
            self._write_all(optimized)
        return {"processed": len(facts), "removed_duplicates": removed, "remaining": len(optimized)}

    def _read_all(self) -> list[MemoryFact]:
        if not self.store_path.exists():
            return []
        facts: list[MemoryFact] = []
        for line in self.store_path.read_text().splitlines():
            if not line.strip():
                continue
            raw = json.loads(line)
            scope_raw = raw["scope"]
            facts.append(
                MemoryFact(
                    id=raw["id"],
                    scope=MemoryScope(scope_raw["kind"], scope_raw.get("project_path"), scope_raw.get("path")),
                    text=raw["text"],
                    source=raw["source"],
                    tags=tuple(raw.get("tags", [])),
                    created_at=raw["created_at"],
                    updated_at=raw["updated_at"],
                )
            )
        return facts

    def _write_all(self, facts: list[MemoryFact]) -> None:
        self.store_path.write_text("\n".join(json.dumps(_fact_json(fact), sort_keys=True) for fact in facts) + ("\n" if facts else ""))
        canonical = {
            "version": 1,
            "facts": [
                {
                    "id": fact.id,
                    "scope_key": fact.scope.key(),
                    "topic_key": _canonical_text(fact.text)[:80],
                    "text": fact.text,
                    "updated_at": fact.updated_at,
                }
                for fact in facts
            ],
        }
        self.index_path.write_text(json.dumps(canonical, indent=2, sort_keys=True))

    def _find_duplicate(self, facts: list[MemoryFact], text: str, scope: MemoryScope) -> MemoryFact | None:
        canonical = _canonical_text(text)
        for fact in facts:
            if _same_scope(fact.scope, scope) and _canonical_text(fact.text) == canonical:
                return fact
        return None


def _fact_json(fact: MemoryFact) -> dict[str, object]:
    data = asdict(fact)
    data["scope"] = asdict(fact.scope)
    data["tags"] = list(fact.tags)
    return data


def _scope_visible(candidate: MemoryScope, requested: MemoryScope) -> bool:
    if candidate.kind == "global":
        return True
    if requested.kind == "global":
        return candidate.kind == "global"
    if candidate.kind == "project":
        return _stable_path(candidate.project_path or "") == _stable_path(requested.project_path or "")
    if requested.kind != "path":
        return False
    return (
        _stable_path(candidate.project_path or "") == _stable_path(requested.project_path or "")
        and _stable_path(candidate.path or "") == _stable_path(requested.path or "")
    )


def _same_scope(left: MemoryScope, right: MemoryScope) -> bool:
    return left.key() == right.key()


def _lexical_score(query_terms: set[str], fact: MemoryFact) -> float:
    if not query_terms:
        return 0.0
    text_terms = _terms(fact.text)
    tag_terms = set(term.lower() for term in fact.tags)
    overlap = query_terms & (text_terms | tag_terms)
    if not overlap:
        return 0.0
    return len(overlap) / max(1, len(query_terms)) + min(0.25, len(overlap) * 0.03)


def _terms(text: str) -> set[str]:
    return {
        term.strip(".,:;()[]{}<>\"'`").lower()
        for term in re.findall(r"[A-Za-z0-9_./-]{3,}", text)
        if term.strip(".,:;()[]{}<>\"'`")
    }


def _canonical_text(text: str) -> str:
    return " ".join(sorted(_terms(text)))


def _stable_path(path: str) -> str:
    return Path(path).expanduser().resolve().as_posix()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
