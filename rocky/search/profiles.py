from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ProfileBudget:
    max_primary_points: int = 8
    max_primary_files: int = 5
    max_primary_lines: int = 240
    max_deferred_clusters: int = 6
    max_total_response_chars: int = 10_000

    @classmethod
    def from_raw(cls, raw: dict[str, Any] | None, profile: str) -> "ProfileBudget":
        defaults = DEFAULT_PROFILE_BUDGETS.get(profile, DEFAULT_PROFILE_BUDGETS["bug_investigation"])
        raw = raw or {}
        return cls(
            max_primary_points=_bounded_int(raw.get("max_primary_points"), defaults.max_primary_points, 1, 50),
            max_primary_files=_bounded_int(raw.get("max_primary_files"), defaults.max_primary_files, 1, 30),
            max_primary_lines=_bounded_int(raw.get("max_primary_lines"), defaults.max_primary_lines, 20, 2_000),
            max_deferred_clusters=_bounded_int(raw.get("max_deferred_clusters"), defaults.max_deferred_clusters, 0, 50),
            max_total_response_chars=_bounded_int(
                raw.get("max_total_response_chars"),
                defaults.max_total_response_chars,
                4_000,
                50_000,
            ),
        )

    def as_dict(self) -> dict[str, int]:
        return {
            "max_primary_points": self.max_primary_points,
            "max_primary_files": self.max_primary_files,
            "max_primary_lines": self.max_primary_lines,
            "max_deferred_clusters": self.max_deferred_clusters,
            "max_total_response_chars": self.max_total_response_chars,
        }


PROFILE_DESCRIPTIONS: dict[str, str] = {
    "find_definition": "Find canonical definitions and immediate symbol context.",
    "trace_impact": "Find impacted references, callers, callees, tests, and boundaries.",
    "bug_investigation": "Find the smallest useful spans to diagnose a symptom or failure.",
    "implementation_planning": "Find contracts, modules, tests, and examples needed to implement behavior.",
    "test_discovery": "Find relevant tests, fixtures, mocks, and assertions.",
    "config_lookup": "Find settings schema, environment variables, defaults, and usages.",
    "api_route_lookup": "Find routes, request/response models, services, and callers.",
    "architecture_overview": "Find bounded package, entrypoint, and dependency representatives.",
    "memory_contract": "Find memory backend interfaces, adapters, endpoints, and tests.",
    "codebase_contract": "Find codebase search, indexing, scope, and evidence contracts.",
}


DEFAULT_PROFILE_BUDGETS: dict[str, ProfileBudget] = {
    "find_definition": ProfileBudget(max_primary_points=4, max_primary_files=3, max_primary_lines=120, max_deferred_clusters=4, max_total_response_chars=10_000),
    "trace_impact": ProfileBudget(max_primary_points=8, max_primary_files=6, max_primary_lines=260, max_deferred_clusters=8, max_total_response_chars=10_000),
    "bug_investigation": ProfileBudget(max_primary_points=8, max_primary_files=5, max_primary_lines=260, max_deferred_clusters=8, max_total_response_chars=10_000),
    "implementation_planning": ProfileBudget(max_primary_points=10, max_primary_files=7, max_primary_lines=320, max_deferred_clusters=8, max_total_response_chars=10_000),
    "test_discovery": ProfileBudget(max_primary_points=8, max_primary_files=6, max_primary_lines=240, max_deferred_clusters=6, max_total_response_chars=10_000),
    "config_lookup": ProfileBudget(max_primary_points=6, max_primary_files=5, max_primary_lines=180, max_deferred_clusters=5, max_total_response_chars=10_000),
    "api_route_lookup": ProfileBudget(max_primary_points=8, max_primary_files=6, max_primary_lines=240, max_deferred_clusters=6, max_total_response_chars=10_000),
    "architecture_overview": ProfileBudget(max_primary_points=12, max_primary_files=10, max_primary_lines=360, max_deferred_clusters=10, max_total_response_chars=10_000),
    "memory_contract": ProfileBudget(max_primary_points=8, max_primary_files=6, max_primary_lines=240, max_deferred_clusters=6, max_total_response_chars=10_000),
    "codebase_contract": ProfileBudget(max_primary_points=8, max_primary_files=6, max_primary_lines=240, max_deferred_clusters=6, max_total_response_chars=10_000),
}


PROFILE_QUERY_BOOSTS: dict[str, tuple[str, ...]] = {
    "find_definition": ("class", "def", "function", "interface", "type", "export", "route"),
    "trace_impact": ("call", "reference", "import", "test", "mock", "fixture"),
    "bug_investigation": ("error", "fail", "retry", "loop", "state", "abort", "continue", "turn"),
    "implementation_planning": ("interface", "adapter", "schema", "test", "route", "config"),
    "test_discovery": ("describe", "it(", "test(", "expect", "fixture", "mock"),
    "config_lookup": ("settings", "config", "schema", "env", "default", "process.env"),
    "api_route_lookup": ("router", "route", "request", "response", "endpoint", "/v1/"),
    "architecture_overview": ("index", "server", "entry", "package", "module", "dependency"),
    "memory_contract": ("memory", "store", "recall", "update", "invalidate", "delete"),
    "codebase_contract": ("codebase", "search", "index", "scope", "evidence", "plan"),
}


def normalize_profile(raw: str | None) -> str:
    profile = (raw or "bug_investigation").strip()
    if profile not in PROFILE_DESCRIPTIONS:
        raise ValueError(f"unsupported codebase profile: {profile}")
    return profile


def profile_catalog() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": PROFILE_DESCRIPTIONS[name],
            "default_budget": DEFAULT_PROFILE_BUDGETS[name].as_dict(),
            "query_boosts": list(PROFILE_QUERY_BOOSTS.get(name, ())),
        }
        for name in sorted(PROFILE_DESCRIPTIONS)
    ]


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))
