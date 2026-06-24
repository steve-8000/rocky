from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import time
import ast as py_ast
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from rocky.search.evidence import CodeEvidence, file_revision, line_window, snippet_for, stable_id
from rocky.search.plan_store import JsonPlanStore
from rocky.search.profiles import PROFILE_QUERY_BOOSTS, ProfileBudget, normalize_profile, profile_catalog
from rocky.search.rocky_codebase import RockyCodebaseClient


_SKIP_DIRS = {".git", ".rocky", ".venv", "__pycache__", "node_modules", "vendor", "build", "dist", "coverage"}
_TEXT_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".toml",
    ".yaml",
    ".yml",
    ".rs",
    ".go",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
}


@dataclass(frozen=True)
class ProfileConstraints:
    include_tests: bool
    prefer_changed_files: bool
    allow_lexical_fallback: bool
    allow_llm_summary: bool
    changed_files: tuple[str, ...]

    @classmethod
    def from_raw(cls, raw: dict[str, Any] | None, profile: str, search_scope: dict[str, Any]) -> "ProfileConstraints":
        raw = raw or {}
        include_tests = bool(raw.get("include_tests", profile in {"bug_investigation", "trace_impact", "implementation_planning", "test_discovery"}))
        prefer_changed_files = bool(raw.get("prefer_changed_files", bool(raw.get("changed_files"))))
        changed_files = _normalize_changed_files(raw.get("changed_files"), search_scope)
        if prefer_changed_files and not changed_files:
            changed_files = _git_changed_files(search_scope)
        return cls(
            include_tests=include_tests,
            prefer_changed_files=prefer_changed_files,
            allow_lexical_fallback=bool(raw.get("allow_lexical_fallback", True)),
            allow_llm_summary=bool(raw.get("allow_llm_summary", False)),
            changed_files=changed_files,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "include_tests": self.include_tests,
            "prefer_changed_files": self.prefer_changed_files,
            "allow_lexical_fallback": self.allow_lexical_fallback,
            "allow_llm_summary": self.allow_llm_summary,
            "changed_files": list(self.changed_files),
        }


class RockyProfileEngine:
    def __init__(self, codebase: RockyCodebaseClient, plan_root: str | Path) -> None:
        self.codebase = codebase
        self.store = JsonPlanStore(plan_root)
        self.ast_grep_binary = _ast_grep_binary()
        self.lsp_command = _lsp_command()

    def plan(self, request: dict[str, Any]) -> dict[str, Any]:
        profile = normalize_profile(request.get("profile"))
        query = str(request.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        budget = ProfileBudget.from_raw(request.get("budget"), profile)
        search_scope = self._resolve_scope(request.get("scope") or {})
        constraints = ProfileConstraints.from_raw(request.get("constraints"), profile, search_scope)
        terms = _query_terms(query, profile)
        evidence, collector_stats = self._collect_evidence(profile, query, terms, search_scope, budget, constraints)
        primary, deferred, secondary_by_cluster = self._shape_plan(evidence, budget)
        plan_id = stable_id("cp", {"profile": profile, "query": query, "scope": search_scope, "time": time.time_ns()})
        response = {
            "ok": True,
            "plan_id": plan_id,
            "profile": profile,
            "search_scope": search_scope,
            "constraints": constraints.as_dict(),
            "budget": budget.as_dict(),
            "collector_stats": collector_stats,
            "budget_used": _budget_used(primary),
            "primary": primary,
            "deferred_clusters": deferred[: budget.max_deferred_clusters],
            "next": [
                {"action": "expand_cluster", "cluster_id": cluster["cluster_id"]}
                for cluster in deferred[: min(3, budget.max_deferred_clusters)]
            ],
            "truncated": len(evidence) > len(primary),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if not primary:
            response["empty_reason"] = _empty_reason(profile, query, collector_stats)
        response = self._fit_response_budget(response, budget)
        self.store.put({**response, "_evidence_count": len(evidence), "_secondary_points_by_cluster": secondary_by_cluster})
        return response

    def get_plan(self, plan_id: str) -> dict[str, Any]:
        plan = self.store.get(plan_id)
        return {key: value for key, value in plan.items() if not key.startswith("_")}

    def delete_plan(self, plan_id: str) -> dict[str, Any]:
        return {"ok": True, "deleted": self.store.delete(plan_id)}

    def read_points(self, request: dict[str, Any]) -> dict[str, Any]:
        plan = self.store.get(str(request.get("plan_id") or ""))
        point_ids = set(str(point_id) for point_id in request.get("point_ids", []))
        if not point_ids:
            point_ids = {point["point_id"] for point in plan.get("primary", [])}
        points = [self._refresh_point(point) for point in plan.get("primary", []) if point.get("point_id") in point_ids]
        return {"ok": True, "plan_id": plan["plan_id"], "points": points}

    def validate_points(self, request: dict[str, Any]) -> dict[str, Any]:
        plan = self.store.get(str(request.get("plan_id") or ""))
        point_ids = set(str(point_id) for point_id in request.get("point_ids", []))
        if not point_ids:
            point_ids = {point["point_id"] for point in plan.get("primary", [])}
        points = []
        for point in plan.get("primary", []):
            if point.get("point_id") not in point_ids:
                continue
            absolute = Path(point["absolute_path"])
            current = file_revision(absolute) if absolute.exists() and absolute.is_file() else None
            points.append(
                {
                    "point_id": point["point_id"],
                    "file": point["file"],
                    "expected_revision": point.get("file_revision"),
                    "current_revision": current,
                    "fresh": current == point.get("file_revision"),
                }
            )
        return {"ok": True, "plan_id": plan["plan_id"], "points": points}

    def expand(self, request: dict[str, Any]) -> dict[str, Any]:
        plan = self.store.get(str(request.get("plan_id") or ""))
        cluster_id = str(request.get("cluster_id") or "")
        clusters = [cluster for cluster in plan.get("deferred_clusters", []) if cluster.get("cluster_id") == cluster_id]
        budget = ProfileBudget.from_raw(request.get("budget"), str(plan.get("profile") or "bug_investigation"))
        stored_points = list(plan.get("_secondary_points_by_cluster", {}).get(cluster_id, []))
        points: list[dict[str, Any]] = []
        used_lines = 0
        for point in stored_points:
            refreshed = self._refresh_point(point)
            line_count = max(0, int(refreshed["end_line"]) - int(refreshed["start_line"]) + 1)
            if len(points) >= budget.max_primary_points:
                break
            if used_lines + line_count > budget.max_primary_lines and points:
                break
            points.append(refreshed)
            used_lines += line_count
        return {
            "ok": True,
            "plan_id": plan["plan_id"],
            "cluster_id": cluster_id,
            "cluster": clusters[0] if clusters else None,
            "points": points,
            "budget_used": _budget_used(points),
            "truncated": len(stored_points) > len(points),
        }

    def profiles(self) -> dict[str, Any]:
        return {"ok": True, "profiles": profile_catalog()}

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "collectors": {
                "lexical": {"available": True},
                "graph": {"available": self.codebase.available()},
                "ast": {"available": True, "parsers": ["python_ast", "ts_declaration_scan"]},
                "ast_grep": {"available": self.ast_grep_binary is not None, "binary": self.ast_grep_binary},
                "lsp": (
                    {"available": True, "bridge": self.lsp_command}
                    if self.lsp_command
                    else {"available": False, "reason": "ROCKY_LSP_COLLECTOR_COMMAND is not configured"}
                ),
            },
            "plans": self.store.stats(),
        }

    def _resolve_scope(self, raw_scope: dict[str, Any]) -> dict[str, Any]:
        kind = raw_scope.get("kind") or raw_scope.get("scope") or "workspace"
        roots = raw_scope.get("roots")
        cwd = raw_scope.get("cwd") or raw_scope.get("path") or self.codebase.default_repo_path()
        path = raw_scope.get("path") or (roots[0] if roots else cwd)
        max_parent_depth = raw_scope.get("max_parent_depth")
        scope = self.codebase.resolve_search_scope(
            path=path,
            cwd=cwd,
            scope=kind,
            roots=roots,
            max_parent_depth=max_parent_depth,
        )
        allowed_roots = []
        for root in scope["effective_roots"]:
            root_path = Path(root)
            if root_path.exists() and root_path.is_dir():
                allowed_roots.append(str(root_path.resolve()))
        return {**scope, "effective_roots": allowed_roots, "searched_roots": allowed_roots}

    def _collect_lexical_evidence(
        self,
        profile: str,
        query: str,
        terms: list[str],
        search_scope: dict[str, Any],
        budget: ProfileBudget,
        constraints: ProfileConstraints,
    ) -> list[CodeEvidence]:
        evidence: list[CodeEvidence] = []
        max_results = max(20, budget.max_primary_points * 8)
        max_file_bytes = int(os.getenv("ROCKY_LEXICAL_MAX_FILE_BYTES", "1048576"))
        deadline = time.monotonic() + float(os.getenv("ROCKY_LEXICAL_TIMEOUT_SECONDS", "2.0"))
        for root in search_scope["effective_roots"]:
            root_path = Path(root)
            for path in sorted(root_path.rglob("*")):
                if len(evidence) >= max_results or time.monotonic() > deadline:
                    return sorted(evidence, key=lambda item: item.score, reverse=True)
                if not _is_searchable_file(root_path, path):
                    continue
                rel = path.relative_to(root_path).as_posix()
                if not constraints.include_tests and _is_test_file(rel):
                    continue
                try:
                    if path.stat().st_size > max_file_bytes:
                        continue
                except OSError:
                    continue
                try:
                    lines = path.read_text(errors="replace").splitlines()
                except OSError:
                    continue
                for line_no, line in enumerate(lines, start=1):
                    matched = [term for term in terms if term.lower() in line.lower()]
                    if not matched:
                        continue
                    start, end = line_window(lines, line_no, desired=12)
                    score = _score_line(profile, query, line, matched, rel)
                    payload = {"root": root, "file": rel, "start": start, "end": end, "source": "lexical"}
                    evidence.append(
                        CodeEvidence(
                            evidence_id=stable_id("ev", payload),
                            root=root,
                            file=rel,
                            start_line=start,
                            end_line=end,
                            source="lexical",
                            score=score,
                            confidence=min(0.95, 0.45 + len(set(matched)) * 0.12),
                            matched_terms=tuple(sorted(set(matched))),
                            relation=_relation_for_profile(profile),
                        )
                    )
                    break
        return sorted(evidence, key=lambda item: item.score, reverse=True)

    def _collect_graph_evidence(
        self,
        profile: str,
        query: str,
        search_scope: dict[str, Any],
        budget: ProfileBudget,
        constraints: ProfileConstraints,
    ) -> list[CodeEvidence]:
        if not self.codebase.available():
            return []
        evidence: list[CodeEvidence] = []
        for root in search_scope["effective_roots"]:
            try:
                candidates = self.codebase.search_graph(query, root, limit=max(5, budget.max_primary_points * 3))
            except Exception:
                continue
            root_path = Path(root)
            for candidate in candidates:
                rel = str(candidate.file_path).lstrip("/")
                if not constraints.include_tests and _is_test_file(rel):
                    continue
                absolute = root_path / rel
                if not absolute.exists() or not absolute.is_file() or not _is_searchable_file(root_path, absolute):
                    continue
                start = max(1, int(candidate.start_line or 1))
                end = max(start, int(candidate.end_line or start))
                payload = {"root": root, "file": rel, "start": start, "end": end, "source": "graph"}
                label = candidate.label or candidate.name or None
                evidence.append(
                    CodeEvidence(
                        evidence_id=stable_id("ev", payload),
                        root=root,
                        file=rel,
                        start_line=start,
                        end_line=end,
                        source="graph",
                        score=5.0 + float(candidate.rank or 0),
                        confidence=0.88,
                        matched_terms=tuple(_query_terms(query, profile)[:5]),
                        symbol=label,
                        relation=_relation_for_profile(profile),
                    )
                )
        return evidence

    def _collect_ast_grep_evidence(
        self,
        profile: str,
        query: str,
        search_scope: dict[str, Any],
        budget: ProfileBudget,
        constraints: ProfileConstraints,
    ) -> list[CodeEvidence]:
        if not self.ast_grep_binary:
            return []
        patterns = _ast_grep_patterns(profile, query)
        if not patterns:
            return []
        max_results = max(10, budget.max_primary_points * 4)
        deadline = time.monotonic() + float(os.getenv("ROCKY_AST_GREP_TOTAL_TIMEOUT_SECONDS", "3.0"))
        evidence: list[CodeEvidence] = []
        for root in search_scope["effective_roots"]:
            root_path = Path(root)
            for language, pattern in patterns:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return sorted(evidence, key=lambda item: item.score, reverse=True)
                if len(evidence) >= max_results:
                    return sorted(evidence, key=lambda item: item.score, reverse=True)
                try:
                    completed = subprocess.run(
                        [
                            self.ast_grep_binary,
                            "--pattern",
                            pattern,
                            "--json",
                            "--lang",
                            language,
                            str(root_path),
                        ],
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=max(0.2, min(1.0, remaining)),
                    )
                except (OSError, subprocess.TimeoutExpired):
                    continue
                if completed.returncode not in {0, 1} or not completed.stdout.strip():
                    continue
                try:
                    matches = json.loads(completed.stdout)
                except json.JSONDecodeError:
                    continue
                if not isinstance(matches, list):
                    continue
                for match in matches:
                    parsed = _ast_grep_match_to_evidence(profile, query, root_path, match)
                    if parsed is None:
                        continue
                    if not constraints.include_tests and _is_test_file(parsed.file):
                        continue
                    evidence.append(parsed)
                    if len(evidence) >= max_results:
                        return sorted(evidence, key=lambda item: item.score, reverse=True)
        return sorted(evidence, key=lambda item: item.score, reverse=True)

    def _collect_ast_evidence(
        self,
        profile: str,
        query: str,
        terms: list[str],
        search_scope: dict[str, Any],
        budget: ProfileBudget,
        constraints: ProfileConstraints,
    ) -> list[CodeEvidence]:
        evidence: list[CodeEvidence] = []
        max_results = max(20, budget.max_primary_points * 5)
        scanned = 0
        scan_limit = max(600, budget.max_primary_points * 100)
        for root in search_scope["effective_roots"]:
            root_path = Path(root)
            for path in sorted(root_path.rglob("*")):
                if scanned >= scan_limit or len(evidence) >= max_results:
                    return sorted(evidence, key=lambda item: item.score, reverse=True)
                if not _is_searchable_file(root_path, path):
                    continue
                if path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx"}:
                    continue
                scanned += 1
                try:
                    text = path.read_text(errors="replace")
                except OSError:
                    continue
                rel = path.relative_to(root_path).as_posix()
                if not constraints.include_tests and _is_test_file(rel):
                    continue
                if path.suffix == ".py":
                    evidence.extend(_python_ast_evidence(profile, query, terms, root_path, rel, text))
                else:
                    evidence.extend(_ts_symbol_evidence(profile, query, terms, root_path, rel, text))
                if len(evidence) >= max_results:
                    return sorted(evidence, key=lambda item: item.score, reverse=True)
        return sorted(evidence, key=lambda item: item.score, reverse=True)

    def _collect_lsp_evidence(
        self,
        profile: str,
        query: str,
        terms: list[str],
        search_scope: dict[str, Any],
        budget: ProfileBudget,
        constraints: ProfileConstraints,
    ) -> list[CodeEvidence]:
        if not self.lsp_command:
            return []
        timeout = float(os.getenv("ROCKY_LSP_COLLECTOR_TIMEOUT_SECONDS", "2.0"))
        max_results = max(5, budget.max_primary_points * 3)
        request = {
            "profile": profile,
            "query": query,
            "terms": terms[:16],
            "search_scope": search_scope,
            "budget": budget.as_dict(),
            "constraints": constraints.as_dict(),
            "max_results": max_results,
        }
        try:
            completed = subprocess.run(
                self.lsp_command,
                input=json.dumps(request),
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        if completed.returncode != 0 or not completed.stdout.strip():
            return []
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return []
        raw_items = payload.get("evidence") if isinstance(payload, dict) else payload
        if not isinstance(raw_items, list):
            return []
        evidence: list[CodeEvidence] = []
        roots = [Path(root).resolve() for root in search_scope.get("effective_roots", [])]
        for item in raw_items[:max_results]:
            parsed = _lsp_item_to_evidence(profile, query, roots, item)
            if parsed is None:
                continue
            if not constraints.include_tests and _is_test_file(parsed.file):
                continue
            evidence.append(parsed)
        return sorted(evidence, key=lambda item: item.score, reverse=True)

    def _collect_evidence(
        self,
        profile: str,
        query: str,
        terms: list[str],
        search_scope: dict[str, Any],
        budget: ProfileBudget,
        constraints: ProfileConstraints,
    ) -> tuple[list[CodeEvidence], dict[str, dict[str, Any]]]:
        collected: list[CodeEvidence] = []
        stats: dict[str, dict[str, Any]] = {}
        for name, available, skipped_reason, collector in [
            (
                "lsp",
                self.lsp_command is not None,
                None if self.lsp_command else "not_configured",
                lambda: self._collect_lsp_evidence(profile, query, terms, search_scope, budget, constraints),
            ),
            (
                "graph",
                self.codebase.available(),
                None if self.codebase.available() else "unavailable",
                lambda: self._collect_graph_evidence(profile, query, search_scope, budget, constraints),
            ),
            (
                "ast",
                True,
                None,
                lambda: self._collect_ast_evidence(profile, query, terms, search_scope, budget, constraints),
            ),
            (
                "ast_grep",
                self.ast_grep_binary is not None,
                None if self.ast_grep_binary else "not_configured",
                lambda: self._collect_ast_grep_evidence(profile, query, search_scope, budget, constraints),
            ),
        ]:
            items, stat = _run_collector(name, available, skipped_reason, collector)
            stats[name] = stat
            collected.extend(items)
        if constraints.allow_lexical_fallback:
            items, stat = _run_collector(
                "lexical",
                True,
                None,
                lambda: self._collect_lexical_evidence(profile, query, terms, search_scope, budget, constraints),
            )
            stats["lexical"] = stat
            collected.extend(items)
        else:
            stats["lexical"] = {"available": True, "returned": 0, "elapsed_ms": 0, "skipped_reason": "disabled_by_constraints"}
        return _fuse_evidence(_apply_constraints(collected, constraints)), stats

    def _shape_plan(
        self,
        evidence: list[CodeEvidence],
        budget: ProfileBudget,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
        primary: list[dict[str, Any]] = []
        secondary_by_cluster: dict[str, list[dict[str, Any]]] = defaultdict(list)
        used_files: set[str] = set()
        used_lines = 0
        seen_keys: set[tuple[str, int, int, str]] = set()
        primary_point_keys: set[tuple[str, int, int, str]] = set()
        deferred_by_dir: dict[str, list[CodeEvidence]] = defaultdict(list)
        for item in evidence:
            deferred_by_dir[_cluster_key(item.file)].append(item)
            if item.key() in seen_keys:
                continue
            point = self._point_for_evidence(item)
            if point is None:
                continue
            if len(primary) >= budget.max_primary_points:
                secondary_by_cluster[point["cluster_id"]].append(point)
                seen_keys.add(item.key())
                continue
            if item.file not in used_files and len(used_files) >= budget.max_primary_files:
                secondary_by_cluster[point["cluster_id"]].append(point)
                seen_keys.add(item.key())
                continue
            line_count = max(0, int(point["end_line"]) - int(point["start_line"]) + 1)
            if used_lines + line_count > budget.max_primary_lines and primary:
                secondary_by_cluster[point["cluster_id"]].append(point)
                seen_keys.add(item.key())
                continue
            primary.append(point)
            primary_point_keys.add(item.key())
            used_files.add(item.file)
            used_lines += line_count
            seen_keys.add(item.key())
        primary_ids = {point["cluster_id"] for point in primary}
        for item in evidence:
            if item.key() in primary_point_keys:
                continue
            point = self._point_for_evidence(item)
            if point is not None and point not in secondary_by_cluster[point["cluster_id"]]:
                secondary_by_cluster[point["cluster_id"]].append(point)
        clusters = [
            _cluster_manifest(cluster_key, items)
            for cluster_key, items in sorted(deferred_by_dir.items(), key=lambda pair: len(pair[1]), reverse=True)
            if stable_id("cluster", cluster_key) not in primary_ids or len(items) > 1
        ]
        visible_cluster_ids = {cluster["cluster_id"] for cluster in clusters}
        secondary_visible = {
            cluster_id: points
            for cluster_id, points in secondary_by_cluster.items()
            if cluster_id in visible_cluster_ids and points
        }
        return primary, clusters, secondary_visible

    def _point_for_evidence(self, item: CodeEvidence) -> dict[str, Any] | None:
        absolute = Path(item.root) / item.file
        try:
            snippet, _line_count = snippet_for(absolute, item.start_line, item.end_line)
            revision = file_revision(absolute)
        except OSError:
            return None
        point_id = stable_id("pt", {"file": item.file, "start": item.start_line, "end": item.end_line, "root": item.root})
        return {
            "point_id": point_id,
            "file": item.file,
            "absolute_path": str(absolute.resolve()),
            "start_line": item.start_line,
            "end_line": item.end_line,
            "symbol": item.symbol,
            "snippet": snippet,
            "file_revision": revision,
            "signals": _signals_for(item),
            "reason": _reason_for(item),
            "confidence": round(item.confidence, 3),
            "cluster_id": stable_id("cluster", _cluster_key(item.file)),
        }

    def _refresh_point(self, point: dict[str, Any]) -> dict[str, Any]:
        absolute = Path(point["absolute_path"])
        current_revision = file_revision(absolute) if absolute.exists() and absolute.is_file() else None
        if absolute.exists() and absolute.is_file():
            snippet, _line_count = snippet_for(absolute, int(point["start_line"]), int(point["end_line"]))
        else:
            snippet = ""
        return {
            **{key: value for key, value in point.items() if key != "absolute_path"},
            "snippet": snippet,
            "current_revision": current_revision,
            "fresh": current_revision == point.get("file_revision"),
        }

    def _fit_response_budget(self, response: dict[str, Any], budget: ProfileBudget) -> dict[str, Any]:
        response["budget_used"] = _budget_used(response.get("primary", []))
        response["budget_used"]["response_chars"] = len(json.dumps(response, ensure_ascii=False))
        while response["primary"] and response["budget_used"]["response_chars"] > budget.max_total_response_chars:
            response["primary"].pop()
            response["truncated"] = True
            response["budget_used"] = _budget_used(response.get("primary", []))
            response["budget_used"]["response_chars"] = len(json.dumps(response, ensure_ascii=False))
        return response


def _query_terms(query: str, profile: str) -> list[str]:
    terms = _query_literal_terms(query)
    terms.extend(PROFILE_QUERY_BOOSTS.get(profile, ()))
    result: list[str] = []
    seen: set[str] = set()
    for term in terms:
        lowered = term.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        result.append(term)
    return result[:24]


def _query_literal_terms(query: str) -> list[str]:
    return [term for term in re.findall(r"[A-Za-z0-9_./:-]{3,}", query) if not term.startswith("http")]


def _is_searchable_file(root: Path, path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        rel_parts = path.relative_to(root).parts
    except ValueError:
        return False
    if any(part in _SKIP_DIRS for part in rel_parts):
        return False
    return path.suffix in _TEXT_SUFFIXES


def _is_test_file(rel: str) -> bool:
    parts = Path(rel).parts
    lowered = rel.lower()
    return (
        any(part in {"test", "tests", "__tests__", "spec", "specs"} for part in parts)
        or lowered.endswith((".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx", "_test.py", "_spec.py"))
        or "/test_" in lowered
    )


def _run_collector(
    name: str,
    available: bool,
    skipped_reason: str | None,
    collector: Any,
) -> tuple[list[CodeEvidence], dict[str, Any]]:
    if not available:
        return [], {"available": False, "returned": 0, "elapsed_ms": 0, "skipped_reason": skipped_reason or "unavailable"}
    started = time.perf_counter()
    try:
        items = collector()
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return [], {"available": True, "returned": 0, "elapsed_ms": elapsed_ms, "failed": True, "error": type(exc).__name__}
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return items, {"available": True, "returned": len(items), "elapsed_ms": elapsed_ms}


def _normalize_changed_files(raw: Any, search_scope: dict[str, Any]) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    roots = [Path(root).resolve() for root in search_scope.get("effective_roots", [])]
    changed: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            continue
        path = Path(item).expanduser()
        rel: str | None = None
        if path.is_absolute():
            resolved = path.resolve()
            for root in roots:
                try:
                    rel = resolved.relative_to(root).as_posix()
                    break
                except ValueError:
                    continue
        else:
            rel = path.as_posix().lstrip("./")
        if rel and rel not in changed:
            changed.append(rel)
    return tuple(changed[:200])


def _git_changed_files(search_scope: dict[str, Any]) -> tuple[str, ...]:
    changed: list[str] = []
    for root in search_scope.get("effective_roots", []):
        try:
            completed = subprocess.run(
                ["git", "-C", str(root), "status", "--short", "--untracked-files=all"],
                check=False,
                capture_output=True,
                text=True,
                timeout=0.8,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if completed.returncode != 0:
            continue
        for line in completed.stdout.splitlines():
            if not line or len(line) < 4:
                continue
            rel = line[3:].strip()
            if " -> " in rel:
                rel = rel.split(" -> ", 1)[1].strip()
            if rel and rel not in changed:
                changed.append(rel)
            if len(changed) >= 200:
                return tuple(changed)
    return tuple(changed)


def _apply_constraints(items: list[CodeEvidence], constraints: ProfileConstraints) -> list[CodeEvidence]:
    if not constraints.changed_files:
        return items
    changed = set(constraints.changed_files)
    boosted: list[CodeEvidence] = []
    for item in items:
        if item.file not in changed:
            boosted.append(item)
            continue
        metadata = {**item.metadata, "changed_file": True}
        boosted.append(replace(item, score=item.score + 20.0, confidence=min(0.99, item.confidence + 0.04), metadata=metadata))
    return boosted


def _signals_for(item: CodeEvidence) -> list[str]:
    signals = item.source.split("+")
    if item.metadata.get("changed_file") is True and "changed_file" not in signals:
        signals.append("changed_file")
    return signals


def _score_line(profile: str, query: str, line: str, matched: list[str], rel: str) -> float:
    score = float(len(set(term.lower() for term in matched)))
    lowered = line.lower()
    for boost in PROFILE_QUERY_BOOSTS.get(profile, ()):
        if boost.lower() in lowered:
            score += 0.4
    if any(term.lower() in rel.lower() for term in re.findall(r"[A-Za-z0-9_-]{4,}", query)):
        score += 0.8
    if "/test" in rel or rel.endswith(".test.ts") or rel.endswith("_test.py"):
        score += 0.2 if profile in {"test_discovery", "bug_investigation"} else -0.3
    return score


def _relation_for_profile(profile: str) -> str:
    if profile == "find_definition":
        return "definition"
    if profile in {"trace_impact", "api_route_lookup"}:
        return "reference"
    if profile == "test_discovery":
        return "test"
    if profile == "config_lookup":
        return "config"
    return "pattern_match"


def _reason_for(item: CodeEvidence) -> str:
    terms = ", ".join(item.matched_terms[:5])
    return f"{item.source} match for {terms} in {item.file}"


def _cluster_key(file: str) -> str:
    parts = Path(file).parts
    if len(parts) <= 1:
        return "."
    return "/".join(parts[: min(3, len(parts) - 1)])


def _cluster_manifest(cluster_key: str, items: list[CodeEvidence]) -> dict[str, Any]:
    files = sorted({item.file for item in items})
    sources = Counter(item.source for item in items)
    label = cluster_key if cluster_key != "." else "repository root"
    cluster_id = stable_id("cluster", cluster_key)
    return {
        "cluster_id": cluster_id,
        "label": label,
        "manifest": f"{len(items)} points across {len(files)} files; signals: {', '.join(sorted(sources))}",
        "count": len(items),
        "file_count": len(files),
        "top_files": files[:5],
        "expandable": True,
    }


def _budget_used(points: list[dict[str, Any]]) -> dict[str, int]:
    files = {point["file"] for point in points}
    lines = sum(max(0, int(point["end_line"]) - int(point["start_line"]) + 1) for point in points)
    return {"primary_points": len(points), "primary_files": len(files), "primary_lines": lines}


def _empty_reason(profile: str, query: str, collector_stats: dict[str, dict[str, Any]]) -> dict[str, Any]:
    active = [name for name, stats in collector_stats.items() if stats.get("available") and not stats.get("skipped_reason")]
    skipped = {name: stats.get("skipped_reason") for name, stats in collector_stats.items() if stats.get("skipped_reason")}
    return {
        "code": "no_evidence",
        "message": f"No Rocky codebase evidence matched profile={profile} query={query!r}.",
        "active_collectors": active,
        "skipped_collectors": skipped,
        "collector_stats": collector_stats,
        "next": [
            "relax constraints",
            "try a broader scope",
            "expand query terms",
        ],
    }


def _python_ast_evidence(
    profile: str,
    query: str,
    terms: list[str],
    root_path: Path,
    rel: str,
    text: str,
) -> list[CodeEvidence]:
    try:
        tree = py_ast.parse(text)
    except SyntaxError:
        return []
    evidence: list[CodeEvidence] = []
    parents: dict[py_ast.AST, py_ast.AST] = {}
    for parent in py_ast.walk(tree):
        for child in py_ast.iter_child_nodes(parent):
            parents[child] = parent
    for node in py_ast.walk(tree):
        if not isinstance(node, (py_ast.ClassDef, py_ast.FunctionDef, py_ast.AsyncFunctionDef)):
            continue
        parent = parents.get(node)
        symbol = node.name
        if isinstance(parent, py_ast.ClassDef) and isinstance(node, (py_ast.FunctionDef, py_ast.AsyncFunctionDef)):
            symbol = f"{parent.name}.{node.name}"
        matched = _symbol_matches(symbol, rel, terms)
        if not matched and not _allow_unmatched_symbols(profile):
            continue
        start = int(getattr(node, "lineno", 1) or 1)
        end = int(getattr(node, "end_lineno", start) or start)
        evidence.append(
            _symbol_evidence(
                profile=profile,
                query=query,
                root_path=root_path,
                rel=rel,
                start=start,
                end=end,
                symbol=symbol,
                matched=matched,
                score_base=7.0,
            )
        )
    return evidence


def _ts_symbol_evidence(
    profile: str,
    query: str,
    terms: list[str],
    root_path: Path,
    rel: str,
    text: str,
) -> list[CodeEvidence]:
    patterns = [
        re.compile(r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+(?P<name>[A-Za-z_$][\w$]*)"),
        re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(?P<name>[A-Za-z_$][\w$]*)\s*\("),
        re.compile(r"^\s*(?:export\s+)?interface\s+(?P<name>[A-Za-z_$][\w$]*)"),
        re.compile(r"^\s*(?:export\s+)?type\s+(?P<name>[A-Za-z_$][\w$]*)\s*="),
        re.compile(r"^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(?P<name>[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]"),
    ]
    evidence: list[CodeEvidence] = []
    lines = text.splitlines()
    current_class: str | None = None
    for index, line in enumerate(lines, start=1):
        for pattern in patterns:
            match = pattern.search(line)
            if not match:
                continue
            name = match.group("name")
            if pattern is patterns[0]:
                current_class = name
            symbol = f"{current_class}.{name}" if current_class and pattern is patterns[-1] else name
            matched = _symbol_matches(symbol, rel, terms)
            if not matched and not _allow_unmatched_symbols(profile):
                continue
            start, end = line_window(lines, index, desired=12)
            evidence.append(
                _symbol_evidence(
                    profile=profile,
                    query=query,
                    root_path=root_path,
                    rel=rel,
                    start=start,
                    end=end,
                    symbol=symbol,
                    matched=matched,
                    score_base=6.5,
                )
            )
            break
    return evidence


def _symbol_matches(symbol: str, rel: str, terms: list[str]) -> tuple[str, ...]:
    haystack = f"{symbol} {rel}".lower()
    return tuple(term for term in terms if term.lower().replace("/", " ") in haystack or term.lower() in haystack)


def _allow_unmatched_symbols(profile: str) -> bool:
    return profile == "architecture_overview"


def _symbol_evidence(
    *,
    profile: str,
    query: str,
    root_path: Path,
    rel: str,
    start: int,
    end: int,
    symbol: str,
    matched: tuple[str, ...],
    score_base: float,
) -> CodeEvidence:
    payload = {"root": str(root_path), "file": rel, "start": start, "end": end, "source": "ast", "symbol": symbol}
    confidence = 0.84 + min(0.12, len(set(matched)) * 0.03)
    return CodeEvidence(
        evidence_id=stable_id("ev", payload),
        root=str(root_path.resolve()),
        file=rel,
        start_line=start,
        end_line=end,
        source="ast",
        score=score_base + len(set(matched)) * 0.6,
        confidence=min(0.97, confidence),
        matched_terms=tuple(sorted(set(matched))) or tuple(_query_terms(query, profile)[:3]),
        symbol=symbol,
        relation="definition",
    )


def _ast_grep_binary() -> str | None:
    configured = os.getenv("ROCKY_AST_GREP_BINARY")
    if configured:
        path = Path(configured).expanduser()
        if path.exists():
            return str(path)
    return shutil.which("ast-grep") or shutil.which("sg")


def _lsp_command() -> list[str] | None:
    configured = os.getenv("ROCKY_LSP_COLLECTOR_COMMAND", "").strip()
    if not configured:
        return None
    try:
        command = shlex.split(configured)
    except ValueError:
        return None
    if not command:
        return None
    binary = command[0]
    if "/" in binary or binary.startswith("."):
        if not Path(binary).expanduser().exists():
            return None
    elif shutil.which(binary) is None:
        return None
    return command


def _lsp_item_to_evidence(
    profile: str,
    query: str,
    roots: list[Path],
    item: Any,
) -> CodeEvidence | None:
    if not isinstance(item, dict):
        return None
    file_raw = item.get("file") or item.get("path") or item.get("uri")
    if not isinstance(file_raw, str) or not file_raw:
        return None
    if file_raw.startswith("file://"):
        file_raw = file_raw.removeprefix("file://")
    root_path: Path | None = None
    rel: str | None = None
    path = Path(file_raw).expanduser()
    if path.is_absolute():
        resolved = path.resolve()
        for root in roots:
            try:
                rel = resolved.relative_to(root).as_posix()
                root_path = root
                break
            except ValueError:
                continue
    else:
        for root in roots:
            candidate = root / path
            if candidate.exists():
                root_path = root
                rel = path.as_posix().lstrip("./")
                break
    if root_path is None or rel is None:
        return None
    absolute = root_path / rel
    if not _is_searchable_file(root_path, absolute):
        return None
    try:
        start = max(1, int(item.get("start_line") or item.get("line") or 1))
        end = max(start, int(item.get("end_line") or start))
    except (TypeError, ValueError):
        return None
    try:
        score = float(item.get("score", 8.0))
    except (TypeError, ValueError):
        score = 8.0
    try:
        confidence = float(item.get("confidence", 0.9))
    except (TypeError, ValueError):
        confidence = 0.9
    raw_terms = item.get("matched_terms")
    matched_terms = tuple(str(term) for term in raw_terms if isinstance(term, str)) if isinstance(raw_terms, list) else tuple(_query_terms(query, profile)[:5])
    payload = {"root": str(root_path), "file": rel, "start": start, "end": end, "source": "lsp", "symbol": item.get("symbol")}
    return CodeEvidence(
        evidence_id=stable_id("ev", payload),
        root=str(root_path.resolve()),
        file=rel,
        start_line=start,
        end_line=end,
        source="lsp",
        score=min(50.0, max(0.0, score)),
        confidence=min(0.99, max(0.0, confidence)),
        matched_terms=matched_terms[:12],
        symbol=str(item.get("symbol")) if item.get("symbol") else None,
        relation=str(item.get("relation") or _relation_for_profile(profile)),
        metadata={"lsp_kind": item.get("kind")},
    )


def _ast_grep_patterns(profile: str, query: str) -> list[tuple[str, str]]:
    patterns: list[tuple[str, str]] = []
    if profile == "api_route_lookup":
        for method in ("get", "post", "put", "patch", "delete"):
            patterns.append(("ts", f"router.{method}($$$)"))
            patterns.append(("ts", f"app.{method}($$$)"))
            patterns.append(("python", f"@router.{method}($$$)"))
    elif profile == "memory_contract":
        for method in ("store", "recall", "update", "invalidate", "delete"):
            patterns.append(("ts", f"$OBJ.{method}($$$)"))
            patterns.append(("python", f"$OBJ.{method}($$$)"))
    elif profile == "config_lookup":
        patterns.extend(
            [
                ("ts", "process.env.$KEY"),
                ("ts", "$OBJ.settings.get($$$)"),
                ("python", "os.getenv($$$)"),
            ]
        )
    elif profile == "find_definition":
        patterns.extend(
            [
                ("ts", "class $NAME { $$$ }"),
                ("ts", "function $NAME($$$) { $$$ }"),
                ("python", "class $NAME: $$$"),
                ("python", "def $NAME($$$): $$$"),
            ]
        )
    elif profile in {"bug_investigation", "implementation_planning", "trace_impact"}:
        patterns.extend(
            [
                ("ts", "throw new Error($$$)"),
                ("ts", "catch ($ERR) { $$$ }"),
                ("python", "raise $ERR"),
                ("python", "except $ERR: $$$"),
            ]
        )
    # Add direct call-expression patterns for high-signal dotted query terms.
    for term in re.findall(r"[A-Za-z_$][A-Za-z0-9_$]*\\.[A-Za-z_$][A-Za-z0-9_$]*", query):
        patterns.append(("ts", f"{term}($$$)"))
        patterns.append(("python", f"{term}($$$)"))
    deduped: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in patterns:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped[:24]


def _ast_grep_match_to_evidence(
    profile: str,
    query: str,
    root_path: Path,
    match: Any,
) -> CodeEvidence | None:
    if not isinstance(match, dict):
        return None
    file_raw = match.get("file")
    if not file_raw:
        return None
    absolute = Path(str(file_raw)).expanduser().resolve()
    try:
        rel = absolute.relative_to(root_path.resolve()).as_posix()
    except ValueError:
        return None
    if not _is_searchable_file(root_path, absolute):
        return None
    range_obj = match.get("range") if isinstance(match.get("range"), dict) else {}
    start_obj = range_obj.get("start") if isinstance(range_obj.get("start"), dict) else {}
    end_obj = range_obj.get("end") if isinstance(range_obj.get("end"), dict) else {}
    start = int(start_obj.get("line") or 0) + 1
    end = max(start, int(end_obj.get("line") or start - 1) + 1)
    text = str(match.get("text") or match.get("lines") or "")
    matched_terms = tuple(term for term in _query_terms(query, profile) if term.lower() in text.lower())[:8]
    if profile == "find_definition" and not any(term.lower() in f"{text} {rel}".lower() for term in _query_literal_terms(query)):
        return None
    payload = {"root": str(root_path), "file": rel, "start": start, "end": end, "source": "ast_grep", "text": text[:120]}
    return CodeEvidence(
        evidence_id=stable_id("ev", payload),
        root=str(root_path.resolve()),
        file=rel,
        start_line=start,
        end_line=end,
        source="ast_grep",
        score=6.0 + len(matched_terms) * 0.4,
        confidence=0.86,
        matched_terms=matched_terms,
        relation="pattern_match",
        metadata={"language": match.get("language"), "text": text[:200]},
    )


def _fuse_evidence(items: list[CodeEvidence]) -> list[CodeEvidence]:
    by_span: dict[tuple[str, str, int, int], list[CodeEvidence]] = defaultdict(list)
    for item in items:
        by_span[(item.root, item.file, item.start_line, item.end_line)].append(item)
    fused: list[CodeEvidence] = []
    for group in by_span.values():
        if len(group) == 1:
            fused.append(group[0])
            continue
        sources = tuple(sorted({item.source for item in group}))
        best = max(group, key=lambda item: item.score)
        matched_terms = tuple(sorted({term for item in group for term in item.matched_terms}))
        metadata: dict[str, Any] = {}
        if any(item.metadata.get("changed_file") is True for item in group):
            metadata["changed_file"] = True
        fused.append(
            CodeEvidence(
                evidence_id=stable_id("ev", {"root": best.root, "file": best.file, "start": best.start_line, "end": best.end_line, "sources": sources}),
                root=best.root,
                file=best.file,
                start_line=best.start_line,
                end_line=best.end_line,
                source="+".join(sources),
                score=sum(item.score for item in group) + len(sources),
                confidence=min(0.99, max(item.confidence for item in group) + 0.05 * (len(sources) - 1)),
                matched_terms=matched_terms,
                symbol=next((item.symbol for item in group if item.symbol), None),
                relation=best.relation,
                metadata=metadata,
            )
        )
    return sorted(fused, key=lambda item: item.score, reverse=True)
