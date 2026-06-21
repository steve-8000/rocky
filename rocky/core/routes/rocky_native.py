from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from rocky.integration import build_integrated_search_result
from rocky.memory import MemoryEngine, MemoryScope
from rocky.search import FastContextCodebaseRunner, to_search_json
from rocky.search.codebase_memory import get_codebase_memory_client
from rocky.serve import PRESETS


router = APIRouter()
_memory = MemoryEngine(Path.home() / ".rocky" / "memory")
_cbm = get_codebase_memory_client()
_fastcontext = FastContextCodebaseRunner(_cbm)


@dataclass(frozen=True)
class SearchTargetsResult:
    final_answer: str
    fastcontext_used: bool
    fallback_used: bool
    fastcontext_turns: int = 0
    fastcontext_tool_messages: int = 0
    fastcontext_error: str | None = None
    fastcontext_tool_names: tuple[str, ...] = ()


class ScopeRequest(BaseModel):
    kind: Literal["global", "project", "path"] = "global"
    project_path: str | None = None
    path: str | None = None


class MemoryStoreRequest(BaseModel):
    text: str
    scope: ScopeRequest = Field(default_factory=ScopeRequest)
    source: str = "verified_durable_fact"
    tags: list[str] = Field(default_factory=list)


class MemoryRecallRequest(BaseModel):
    query: str
    scope: ScopeRequest = Field(default_factory=ScopeRequest)
    limit: int = 8


class MemoryDeleteRequest(BaseModel):
    scope: ScopeRequest = Field(default_factory=ScopeRequest)
    id: str | None = None
    text: str | None = None
    text_prefix: str | None = None


class SearchRequest(BaseModel):
    query: str
    path: str = "."
    final_answer: str = ""
    turns: int = 0
    tool_messages: int = 0


class CodebaseIndexRequest(BaseModel):
    path: str = "."


class CodebaseSearchRequest(BaseModel):
    query: str | None = None
    pattern: str | None = None
    path: str = "."
    limit: int = 20


class ContextBuildRequest(SearchRequest):
    scope: ScopeRequest = Field(default_factory=ScopeRequest)


def _scope(raw: ScopeRequest) -> MemoryScope:
    return MemoryScope(raw.kind, project_path=raw.project_path, path=raw.path)


def _fact_json(fact: Any) -> dict[str, Any]:
    return {
        "id": fact.id,
        "scope": fact.scope.key(),
        "text": fact.text,
        "source": fact.source,
        "tags": list(fact.tags),
        "created_at": fact.created_at,
        "updated_at": fact.updated_at,
    }


def _ensure_codebase_indexed(path: str) -> dict[str, Any]:
    try:
        return _cbm.ensure_indexed(path)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _codebase_targets(query: str, path: str, *, limit: int = 8) -> str:
    try:
        candidates = _cbm.search_graph(query, path, limit=limit)
    except Exception:
        return ""
    seen: set[str] = set()
    targets: list[str] = []
    for candidate in candidates:
        target = candidate.target()
        if target not in seen:
            seen.add(target)
            targets.append(target)
    return "\n".join(targets)


async def _search_targets(request: SearchRequest) -> SearchTargetsResult:
    if request.final_answer.strip():
        return SearchTargetsResult(request.final_answer, fastcontext_used=False, fallback_used=False)
    try:
        result = await _fastcontext.search(request.query, request.path)
        request.turns += result.turns
        request.tool_messages += result.tool_messages
        if result.final_answer:
            return SearchTargetsResult(
                result.final_answer,
                fastcontext_used=True,
                fallback_used=False,
                fastcontext_turns=result.turns,
                fastcontext_tool_messages=result.tool_messages,
                fastcontext_error=result.error,
                fastcontext_tool_names=result.tool_names,
            )
        fallback = _codebase_targets(request.query, request.path)
        return SearchTargetsResult(
            fallback,
            fastcontext_used=True,
            fallback_used=True,
            fastcontext_turns=result.turns,
            fastcontext_tool_messages=result.tool_messages,
            fastcontext_error=result.error or "fastcontext returned no final_answer",
            fastcontext_tool_names=result.tool_names,
        )
    except Exception as exc:
        fallback = _codebase_targets(request.query, request.path)
        return SearchTargetsResult(
            fallback,
            fastcontext_used=False,
            fallback_used=True,
            fastcontext_error=str(exc),
        )


@router.get("/v1/runtime/status")
async def runtime_status() -> dict[str, Any]:
    preset = PRESETS["fastcontext"]
    return {
        "ok": True,
        "package": "rocky",
        "modules": {
            "llm": {
                "model": preset.alias,
                "tool_call_parser": preset.tool_call_parser,
                "port_ready": True,
            },
            "search": {"ready": True},
            "memory": {"ready": True, "root": str(_memory.root)},
        },
    }


@router.post("/v1/search")
async def search(request: SearchRequest) -> dict[str, Any]:
    codebase_index = _ensure_codebase_indexed(request.path)
    targets = await _search_targets(request)
    payload = json.loads(
        to_search_json(
            request.query,
            targets.final_answer,
            request.turns,
            request.tool_messages,
            repo=request.path,
        )
    )
    payload["runtime"] = {
        "codebase_index": codebase_index,
        "fastcontext": {
            "used": targets.fastcontext_used,
            "fallback_used": targets.fallback_used,
            "turns": targets.fastcontext_turns,
            "tool_messages": targets.fastcontext_tool_messages,
            "tool_names": list(targets.fastcontext_tool_names),
            "error": targets.fastcontext_error,
        }
    }
    return payload


@router.post("/v1/context/build")
async def context_build(request: ContextBuildRequest) -> dict[str, Any]:
    codebase_index = _ensure_codebase_indexed(request.path)
    targets = await _search_targets(request)
    result = build_integrated_search_result(
        query=request.query,
        path=request.path,
        final_answer=targets.final_answer,
        memory_engine=_memory,
        memory_scope=_scope(request.scope),
        turns=request.turns,
        tool_messages=request.tool_messages,
    )
    result.search_payload["runtime"]["codebase_index"] = codebase_index
    result.search_payload["runtime"]["fastcontext"] = {
        "used": targets.fastcontext_used,
        "fallback_used": targets.fallback_used,
        "turns": targets.fastcontext_turns,
        "tool_messages": targets.fastcontext_tool_messages,
        "tool_names": list(targets.fastcontext_tool_names),
        "error": targets.fastcontext_error,
    }
    return result.search_payload


@router.post("/v1/rocky/memory/store")
@router.post("/v1/memory/store")
async def memory_store(request: MemoryStoreRequest) -> dict[str, Any]:
    fact = _memory.store(
        request.text,
        _scope(request.scope),
        source=request.source,
        tags=tuple(request.tags),
    )
    return {"ok": True, "item": _fact_json(fact)}


@router.post("/v1/rocky/memory/recall")
@router.post("/v1/rocky/memory/search")
@router.post("/v1/memory/recall")
@router.post("/v1/memory/search")
async def memory_recall(request: MemoryRecallRequest) -> dict[str, Any]:
    hits = _memory.recall(request.query, _scope(request.scope), limit=request.limit)
    return {
        "ok": True,
        "items": [
            {
                **_fact_json(hit.fact),
                "score": hit.score,
            }
            for hit in hits
        ],
    }


@router.post("/v1/rocky/memory/delete")
@router.post("/v1/memory/delete")
async def memory_delete(request: MemoryDeleteRequest) -> dict[str, Any]:
    deleted = _memory.delete(
        _scope(request.scope),
        id=request.id,
        text=request.text,
        text_prefix=request.text_prefix,
    )
    return {"ok": True, "deleted": deleted}


@router.post("/v1/rocky/memory/optimize")
@router.post("/v1/memory/optimize")
async def memory_optimize() -> dict[str, Any]:
    return {"ok": True, **_memory.optimize()}


@router.get("/v1/codebase/status")
async def codebase_status() -> dict[str, Any]:
    cfg = _cbm.config
    return {
        "ok": True,
        "enabled": cfg.enabled,
        "available": _cbm.available(),
        "auto_index": cfg.auto_index,
        "endpoint": cfg.endpoint,
        "binary": cfg.binary,
        "project": cfg.project,
    }


@router.post("/v1/codebase/index")
async def codebase_index(request: CodebaseIndexRequest) -> dict[str, Any]:
    return {"ok": True, **_cbm.index_repository(request.path)}


@router.post("/v1/codebase/search_graph")
async def codebase_search_graph(request: CodebaseSearchRequest) -> dict[str, Any]:
    if not request.query:
        return {"ok": False, "error": "query is required"}
    _cbm.ensure_indexed(request.path)
    candidates = _cbm.search_graph(request.query, request.path, limit=request.limit)
    return {"ok": True, "results": [candidate.__dict__ for candidate in candidates]}


@router.post("/v1/codebase/search_code")
async def codebase_search_code(request: CodebaseSearchRequest) -> dict[str, Any]:
    pattern = request.pattern or request.query
    if not pattern:
        return {"ok": False, "error": "pattern or query is required"}
    _cbm.ensure_indexed(request.path)
    candidates = _cbm.search_code(pattern, request.path, limit=request.limit)
    return {"ok": True, "results": [candidate.__dict__ for candidate in candidates]}
