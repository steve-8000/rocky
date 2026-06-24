from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from rocky.core.config import get_config
from rocky.search import to_search_json
from rocky.search.profile_engine import RockyProfileEngine
from rocky.search.rocky_codebase import get_rocky_codebase_client
from rocky.serve import DEFAULT_PRESET, PRESETS


def _runtime_root() -> Path:
    raw = os.getenv("ROCKY_RUNTIME_ROOT")
    return Path(raw).expanduser().resolve() if raw else Path.home() / ".rocky"


router = APIRouter()
_rocky_codebase = get_rocky_codebase_client()
_profile_engine = RockyProfileEngine(_rocky_codebase, _runtime_root() / "codebase-plans")


@dataclass(frozen=True)
class SearchTargetsResult:
    final_answer: str
    fallback_used: bool


class SearchRequest(BaseModel):
    query: str
    path: str = "."
    cwd: str | None = None
    codebase_scope: Literal["cwd", "workspace", "parent_1", "parent_2", "explicit_roots"] = "workspace"
    roots: list[str] | None = None
    max_parent_depth: int | None = None
    final_answer: str = ""


class CodebaseIndexRequest(BaseModel):
    path: str = "."
    cwd: str | None = None
    scope: Literal["cwd", "workspace", "parent_1", "parent_2", "explicit_roots"] = "workspace"
    roots: list[str] | None = None
    max_parent_depth: int | None = None


class CodebaseSearchRequest(BaseModel):
    query: str | None = None
    pattern: str | None = None
    path: str = "."
    cwd: str | None = None
    scope: Literal["cwd", "workspace", "parent_1", "parent_2", "explicit_roots"] = "workspace"
    roots: list[str] | None = None
    max_parent_depth: int | None = None
    limit: int = 50


class CodebaseCallRequest(BaseModel):
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    path: str = "."
    cwd: str | None = None
    scope: Literal["cwd", "workspace", "parent_1", "parent_2", "explicit_roots"] = "workspace"
    roots: list[str] | None = None
    max_parent_depth: int | None = None


class CodebaseProfileScope(BaseModel):
    kind: Literal["cwd", "workspace", "parent_1", "parent_2", "explicit_roots"] = "workspace"
    cwd: str = "."
    roots: list[str] | None = None
    path: str | None = None
    max_parent_depth: int | None = None


class CodebaseProfileBudget(BaseModel):
    max_primary_points: int | None = None
    max_primary_files: int | None = None
    max_primary_lines: int | None = None
    max_deferred_clusters: int | None = None
    max_total_response_chars: int | None = None


class CodebaseProfileConstraints(BaseModel):
    model_config = ConfigDict(extra="forbid")

    include_tests: bool | None = None
    prefer_changed_files: bool | None = None
    allow_lexical_fallback: bool | None = None
    allow_llm_summary: bool | None = None
    changed_files: list[str] | None = None


class CodebaseProfilePlanRequest(BaseModel):
    profile: str = "bug_investigation"
    query: str
    scope: CodebaseProfileScope = Field(default_factory=CodebaseProfileScope)
    budget: CodebaseProfileBudget | None = None
    constraints: CodebaseProfileConstraints | None = None


class CodebaseProfileReadRequest(BaseModel):
    plan_id: str
    point_ids: list[str] = Field(default_factory=list)


class CodebaseProfileExpandRequest(BaseModel):
    plan_id: str
    cluster_id: str
    budget: CodebaseProfileBudget | None = None


class ContextBuildRequest(SearchRequest):
    pass


def _codebase_scope_meta(
    *,
    path: str,
    cwd: str | None = None,
    scope: str = "workspace",
    roots: list[str] | None = None,
    max_parent_depth: int | None = None,
) -> dict[str, Any]:
    return _rocky_codebase.resolve_search_scope(
        path=path,
        cwd=cwd,
        scope=scope,
        roots=roots,
        max_parent_depth=max_parent_depth,
    )


def _ensure_codebase_indexed(path: str) -> dict[str, Any]:
    try:
        return _rocky_codebase.ensure_indexed(path)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _codebase_targets(query: str, path: str, *, limit: int = 8) -> str:
    try:
        candidates = _rocky_codebase.search_graph(query, path, limit=limit)
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
        return SearchTargetsResult(request.final_answer, fallback_used=False)
    return SearchTargetsResult(_codebase_targets(request.query, request.path), fallback_used=True)


@router.get("/v1/runtime/status")
async def runtime_status() -> dict[str, Any]:
    cfg = get_config()
    llm_model = cfg.model_name or PRESETS[DEFAULT_PRESET].alias
    return {
        "ok": True,
        "package": "rocky",
        "modules": {
            "llm": {
                "model": llm_model,
                "tool_call_parser": cfg.tool_call_parser,
                "port_ready": cfg.ready,
            },
            "search": {"ready": True},
        },
    }


@router.post("/v1/search")
async def search(request: SearchRequest) -> dict[str, Any]:
    search_scope = _codebase_scope_meta(
        path=request.path,
        cwd=request.cwd,
        scope=request.codebase_scope,
        roots=request.roots,
        max_parent_depth=request.max_parent_depth,
    )
    codebase_index = [_ensure_codebase_indexed(root) for root in search_scope["effective_roots"]]
    targets = await _search_targets(request)
    payload = json.loads(
        to_search_json(
            request.query,
            targets.final_answer,
            repo=request.path,
        )
    )
    payload["runtime"] = {
        "search_scope": search_scope,
        "codebase_index": codebase_index,
        "codebase_fallback_used": targets.fallback_used,
    }
    return payload


@router.post("/v1/context/build")
async def context_build(request: ContextBuildRequest) -> dict[str, Any]:
    search_scope = _codebase_scope_meta(
        path=request.path,
        cwd=request.cwd,
        scope=request.codebase_scope,
        roots=request.roots,
        max_parent_depth=request.max_parent_depth,
    )
    codebase_index = [_ensure_codebase_indexed(root) for root in search_scope["effective_roots"]]
    targets = await _search_targets(request)
    payload = json.loads(
        to_search_json(
            request.query,
            targets.final_answer,
            repo=request.path,
        )
    )
    payload["runtime"] = {
        "search_scope": search_scope,
        "codebase_index": codebase_index,
        "codebase_fallback_used": targets.fallback_used,
    }
    return payload


@router.get("/v1/rocky/codebase/status")
@router.get("/v1/codebase/status")
async def codebase_status() -> dict[str, Any]:
    cfg = _rocky_codebase.config
    return {
        "ok": True,
        "enabled": cfg.enabled,
        "available": _rocky_codebase.available(),
        "auto_index": cfg.auto_index,
        "endpoint": cfg.endpoint,
        "binary": cfg.binary,
        "project": cfg.project,
    }


@router.get("/v1/rocky/codebase/profiles")
@router.get("/v1/codebase/profiles")
async def codebase_profiles() -> dict[str, Any]:
    return _profile_engine.profiles()


@router.get("/v1/rocky/codebase/health")
@router.get("/v1/codebase/health")
async def codebase_profile_health() -> dict[str, Any]:
    return _profile_engine.health()


@router.post("/v1/rocky/codebase/plan")
@router.post("/v1/codebase/plan")
async def codebase_profile_plan(request: CodebaseProfilePlanRequest) -> dict[str, Any]:
    return _profile_engine.plan(request.model_dump(exclude_none=True))


@router.get("/v1/rocky/codebase/plan/{plan_id}")
@router.get("/v1/codebase/plan/{plan_id}")
async def codebase_profile_get_plan(plan_id: str) -> dict[str, Any]:
    return _profile_engine.get_plan(plan_id)


@router.delete("/v1/rocky/codebase/plan/{plan_id}")
@router.delete("/v1/codebase/plan/{plan_id}")
async def codebase_profile_delete(plan_id: str) -> dict[str, Any]:
    return _profile_engine.delete_plan(plan_id)


@router.post("/v1/rocky/codebase/read")
@router.post("/v1/codebase/read")
async def codebase_profile_read(request: CodebaseProfileReadRequest) -> dict[str, Any]:
    return _profile_engine.read_points(request.model_dump())


@router.post("/v1/rocky/codebase/validate_points")
@router.post("/v1/codebase/validate_points")
async def codebase_profile_validate(request: CodebaseProfileReadRequest) -> dict[str, Any]:
    return _profile_engine.validate_points(request.model_dump())


@router.post("/v1/rocky/codebase/expand")
@router.post("/v1/codebase/expand")
async def codebase_profile_expand(request: CodebaseProfileExpandRequest) -> dict[str, Any]:
    return _profile_engine.expand(request.model_dump(exclude_none=True))


@router.post("/v1/rocky/codebase/index")
@router.post("/v1/codebase/index")
async def codebase_index(request: CodebaseIndexRequest) -> dict[str, Any]:
    search_scope = _codebase_scope_meta(
        path=request.path,
        cwd=request.cwd,
        scope=request.scope,
        roots=request.roots,
        max_parent_depth=request.max_parent_depth,
    )
    results = [_rocky_codebase.index_repository(root) for root in search_scope["effective_roots"]]
    return {"ok": True, "search_scope": search_scope, "results": results}


@router.post("/v1/rocky/codebase/search_graph")
@router.post("/v1/codebase/search_graph")
async def codebase_search_graph(request: CodebaseSearchRequest) -> dict[str, Any]:
    if not request.query:
        return {"ok": False, "error": "query is required"}
    search_scope = _codebase_scope_meta(
        path=request.path,
        cwd=request.cwd,
        scope=request.scope,
        roots=request.roots,
        max_parent_depth=request.max_parent_depth,
    )
    candidates = []
    for root in search_scope["effective_roots"]:
        _rocky_codebase.ensure_indexed(root)
        candidates.extend(_rocky_codebase.search_graph(request.query, root, limit=request.limit))
        if len(candidates) >= request.limit:
            candidates = candidates[: request.limit]
            break
    return {
        "ok": True,
        "search_scope": search_scope,
        "results": [candidate.__dict__ for candidate in candidates],
    }


@router.post("/v1/rocky/codebase/search_code")
@router.post("/v1/codebase/search_code")
async def codebase_search_code(request: CodebaseSearchRequest) -> dict[str, Any]:
    pattern = request.pattern or request.query
    if not pattern:
        return {"ok": False, "error": "pattern or query is required"}
    search_scope = _codebase_scope_meta(
        path=request.path,
        cwd=request.cwd,
        scope=request.scope,
        roots=request.roots,
        max_parent_depth=request.max_parent_depth,
    )
    candidates = []
    for root in search_scope["effective_roots"]:
        _rocky_codebase.ensure_indexed(root)
        candidates.extend(_rocky_codebase.search_code(pattern, root, limit=request.limit))
        if len(candidates) >= request.limit:
            candidates = candidates[: request.limit]
            break
    return {
        "ok": True,
        "search_scope": search_scope,
        "results": [candidate.__dict__ for candidate in candidates],
    }


@router.post("/v1/rocky/codebase/call")
@router.post("/v1/codebase/call")
async def codebase_call(request: CodebaseCallRequest) -> dict[str, Any]:
    """Generic passthrough for project-scoped graph tools (get_code_snippet,
    trace_path, get_architecture, query_graph). Resolves the same search scope as
    search_graph/search_code, ensures the root is indexed, then proxies the tool to
    the rocky-codebase binary so every graph tool shares one project/cache namespace."""
    search_scope = _codebase_scope_meta(
        path=request.path,
        cwd=request.cwd,
        scope=request.scope,
        roots=request.roots,
        max_parent_depth=request.max_parent_depth,
    )
    roots = search_scope["effective_roots"]
    root = roots[0] if roots else (request.cwd or request.path)
    _ensure_codebase_indexed(root)
    try:
        result = _rocky_codebase.call(request.tool, root, request.arguments)
    except ValueError as exc:
        return {"ok": False, "error": str(exc), "search_scope": search_scope}
    except Exception as exc:  # noqa: BLE001 — surface backend failure as structured error
        return {"ok": False, "error": str(exc), "search_scope": search_scope}
    return {"ok": True, "search_scope": search_scope, "result": result}
