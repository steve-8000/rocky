from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .memory import MemoryEngine, MemoryHit, MemoryScope
from .search import to_search_json
from .serve import PRESETS


@dataclass(frozen=True)
class IntegratedSearchResult:
    llm_model: str
    tool_call_parser: str
    memory_hits: tuple[MemoryHit, ...]
    search_payload: dict[str, Any]


def build_integrated_search_result(
    *,
    query: str,
    path: str | Path,
    final_answer: str,
    memory_engine: MemoryEngine,
    memory_scope: MemoryScope,
    turns: int = 0,
    tool_messages: int = 0,
) -> IntegratedSearchResult:
    preset = PRESETS["fastcontext"]
    hits = tuple(memory_engine.recall(query, memory_scope, limit=5))
    payload = json.loads(to_search_json(query, final_answer, turns, tool_messages, repo=path))
    payload["memory"] = {
        "used": True,
        "items": [
            {
                "id": hit.fact.id,
                "scope": hit.fact.scope.key(),
                "text": hit.fact.text,
                "score": hit.score,
                "source": hit.fact.source,
                "tags": list(hit.fact.tags),
            }
            for hit in hits
        ],
    }
    payload["runtime"] = {
        "llm_model": preset.alias,
        "tool_call_parser": preset.tool_call_parser,
        "embedding_model": preset.embedding_model,
    }
    return IntegratedSearchResult(
        llm_model=preset.alias,
        tool_call_parser=preset.tool_call_parser or "",
        memory_hits=hits,
        search_payload=payload,
    )
