from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from rocky.search.profile_engine import RockyProfileEngine
from rocky.search.rocky_codebase import get_rocky_codebase_client


def _runtime_root() -> Path:
    raw = os.getenv("ROCKY_RUNTIME_ROOT")
    return Path(raw).expanduser().resolve() if raw else Path.home() / ".rocky"


router = APIRouter()
_rocky_codebase = get_rocky_codebase_client()
_profile_engine = RockyProfileEngine(_rocky_codebase, _runtime_root() / "codebase-plans")

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


@router.get("/v1/codebase/profiles")
async def codebase_profiles() -> dict[str, Any]:
    return _profile_engine.profiles()


@router.get("/v1/codebase/health")
async def codebase_profile_health() -> dict[str, Any]:
    return _profile_engine.health()


@router.post("/v1/codebase/plan")
async def codebase_profile_plan(request: CodebaseProfilePlanRequest) -> dict[str, Any]:
    return _profile_engine.plan(request.model_dump(exclude_none=True))


@router.get("/v1/codebase/plan/{plan_id}")
async def codebase_profile_get_plan(plan_id: str) -> dict[str, Any]:
    return _profile_engine.get_plan(plan_id)


@router.delete("/v1/codebase/plan/{plan_id}")
async def codebase_profile_delete(plan_id: str) -> dict[str, Any]:
    return _profile_engine.delete_plan(plan_id)


@router.post("/v1/codebase/read")
async def codebase_profile_read(request: CodebaseProfileReadRequest) -> dict[str, Any]:
    return _profile_engine.read_points(request.model_dump())


@router.post("/v1/codebase/validate_points")
async def codebase_profile_validate(request: CodebaseProfileReadRequest) -> dict[str, Any]:
    return _profile_engine.validate_points(request.model_dump())


@router.post("/v1/codebase/expand")
async def codebase_profile_expand(request: CodebaseProfileExpandRequest) -> dict[str, Any]:
    return _profile_engine.expand(request.model_dump(exclude_none=True))

