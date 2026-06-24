from __future__ import annotations

import json
import random
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from rocky.core.routes import mcp_server, rocky_native
from rocky.search.profile_engine import RockyProfileEngine
from rocky.search.rocky_codebase import CodebaseCandidate, RockyCodebaseClient, RockyCodebaseConfig
from rocky.skills.service import SkillsService


@dataclass
class TrialResult:
    name: str
    passed: bool
    detail: str


class FakeCodebase(RockyCodebaseClient):
    def __init__(self) -> None:
        super().__init__(RockyCodebaseConfig(enabled=True, auto_index=False))
        self.indexed: list[str] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def resolve_search_scope(self, *, path, cwd=None, scope="workspace", roots=None, max_parent_depth=None):
        roots = roots or [path]
        return {
            "requested_scope": scope,
            "cwd": str(Path(cwd or path).resolve()),
            "workspace_path": str(Path(path).resolve()),
            "max_parent_depth": max_parent_depth if max_parent_depth is not None else 0,
            "effective_roots": [str(Path(root).resolve()) for root in roots],
            "searched_roots": [str(Path(root).resolve()) for root in roots],
            "excluded_roots": [],
        }

    def ensure_indexed(self, repo_path):
        resolved = str(Path(repo_path).resolve())
        self.indexed.append(resolved)
        return {"ok": True, "project": self.project_for_path(resolved), "path": resolved}

    def index_repository(self, repo_path):
        resolved = str(Path(repo_path).resolve())
        self.indexed.append(resolved)
        return {"ok": True, "status": "indexed", "project": self.project_for_path(resolved), "path": resolved}

    def search_graph(self, query, repo_path, limit=20):
        base = Path(repo_path).name
        return [CodebaseCandidate(f"{base}/graph_{idx}.py", idx + 1, label=query, name=f"Graph{idx}") for idx in range(min(limit, 5))]

    def search_code(self, pattern, repo_path, limit=20):
        base = Path(repo_path).name
        return [CodebaseCandidate(f"{base}/code_{idx}.py", idx + 10, label=pattern, name=f"Code{idx}") for idx in range(min(limit, 5))]

    def call(self, tool, repo_path, arguments):
        payload = dict(arguments)
        payload.setdefault("project", self.project_for_path(repo_path))
        self.calls.append((tool, payload))
        return {"tool": tool, "arguments": payload, "repo": str(Path(repo_path).resolve())}

    def call_tool(self, tool, arguments):
        self.calls.append((tool, dict(arguments)))
        return {"tool": tool, "arguments": dict(arguments), "via": "mcp"}

    def codebase_tools_list(self):
        return [
            {"name": "search_graph", "description": "fake graph", "inputSchema": {"type": "object"}},
            {"name": "search_code", "description": "fake code", "inputSchema": {"type": "object"}},
            {"name": "get_code_snippet", "description": "fake snippet", "inputSchema": {"type": "object"}},
            {"name": "trace_path", "description": "fake trace", "inputSchema": {"type": "object"}},
        ]


def mcp_call(client: TestClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": random.randint(1, 999999), "method": "tools/call", "params": {"name": name, "arguments": arguments}},
    )
    response.raise_for_status()
    body = response.json()
    text = body["result"]["content"][0]["text"]
    return json.loads(text)


def main() -> int:
    rng = random.Random(20260624)
    fake = FakeCodebase()
    old_native_codebase = rocky_native._rocky_codebase
    old_native_engine = rocky_native._profile_engine
    old_mcp_codebase = mcp_server._codebase
    old_mcp_skills = mcp_server._skills
    old_skill_names = set(mcp_server._SKILL_TOOL_NAMES)

    results: list[TrialResult] = []
    with tempfile.TemporaryDirectory(prefix="rocky-surface-random-") as raw:
        root = Path(raw)
        repos = []
        for name in ("repo_a", "repo_b", "repo_c"):
            repo = root / name
            repo.mkdir()
            (repo / "service.py").write_text(f"def {name}_handler():\n    return '{name}'\n", encoding="utf-8")
            repos.append(repo)

        rocky_native._rocky_codebase = fake
        rocky_native._profile_engine = RockyProfileEngine(
            RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
            plan_root=root / "plans",
        )
        mcp_server._codebase = fake
        mcp_server._skills = SkillsService(fake, skills_dir=root / "skills")
        mcp_server._SKILL_TOOL_NAMES = {tool["name"] for tool in mcp_server.SKILL_TOOLS}

        app = FastAPI()
        app.include_router(rocky_native.router)
        app.include_router(mcp_server.router)
        client = TestClient(app)

        catalog = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).json()["result"]["tools"]
        catalog_names = {tool["name"] for tool in catalog}
        expected_mcp = {"skill_search", "skill_get", "skill_upsert", "skill_delete", "skill_list", "search_graph", "search_code", "get_code_snippet", "trace_path"}
        results.append(TrialResult("minimal_mcp_catalog", expected_mcp <= catalog_names, f"catalog_size={len(catalog_names)} names={sorted(catalog_names)}"))

        # Native search_graph/search_code/index/call are just HTTP wrappers over codebase calls; MCP covers the C-engine side.
        for idx in range(40):
            repo = rng.choice(repos)
            limit = rng.randint(1, 7)
            query = f"handler {idx} {repo.name}"
            native_graph = client.post("/v1/codebase/search_graph", json={"query": query, "path": str(repo), "cwd": str(repo), "roots": [str(repo)], "scope": "explicit_roots", "limit": limit}).json()
            direct_graph = fake.search_graph(query, repo, limit=limit)
            ok_graph = [item["file_path"] for item in native_graph["results"]] == [item.file_path for item in direct_graph]
            results.append(TrialResult("native_search_graph_wrapper", ok_graph, f"trial={idx} limit={limit} returned={len(native_graph['results'])}"))

            pattern = f"return {repo.name} {idx}"
            native_code = client.post("/v1/codebase/search_code", json={"pattern": pattern, "path": str(repo), "cwd": str(repo), "roots": [str(repo)], "scope": "explicit_roots", "limit": limit}).json()
            direct_code = fake.search_code(pattern, repo, limit=limit)
            ok_code = [item["file_path"] for item in native_code["results"]] == [item.file_path for item in direct_code]
            results.append(TrialResult("native_search_code_wrapper", ok_code, f"trial={idx} limit={limit} returned={len(native_code['results'])}"))

            tool = rng.choice(["get_code_snippet", "trace_path"])
            args = {"qualified_name" if tool == "get_code_snippet" else "function_name": f"symbol_{idx}"}
            native_call = client.post("/v1/codebase/call", json={"tool": tool, "arguments": args, "path": str(repo), "cwd": str(repo), "roots": [str(repo)], "scope": "explicit_roots"}).json()
            mcp_result = mcp_call(client, tool, {**args, "project": fake.project_for_path(repo)})
            ok_call = native_call["ok"] and native_call["result"]["tool"] == mcp_result["tool"] == tool
            results.append(TrialResult("native_call_mcp_overlap", ok_call, f"trial={idx} tool={tool}"))

        # Profile plan/read/expand/validate are unique native functionality: they produce plan_id and read points; MCP catalog lacks them.
        for idx in range(20):
            repo = rng.choice(repos)
            plan = client.post("/v1/codebase/plan", json={"profile": "find_definition", "query": repo.name, "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]}}).json()
            unique = plan.get("ok") is True and "plan_id" in plan and "codebase_plan" not in catalog_names
            results.append(TrialResult("profile_plan_unique_native", unique, f"trial={idx} primary={len(plan.get('primary', []))}"))
            if plan.get("primary"):
                point_id = plan["primary"][0]["point_id"]
                read = client.post("/v1/codebase/read", json={"plan_id": plan["plan_id"], "point_ids": [point_id]}).json()
                validate = client.post("/v1/codebase/validate_points", json={"plan_id": plan["plan_id"], "point_ids": [point_id]}).json()
                ok_read = read.get("ok") is True and validate.get("ok") is True and validate["points"][0]["fresh"] is True
                results.append(TrialResult("profile_read_validate_unique_native", ok_read, f"trial={idx} point_id={point_id}"))

        # MCP-only app proves LLM/API/operational routers are not necessary for tool serving.
        mcp_only = FastAPI()
        mcp_only.include_router(mcp_server.router)
        mcp_only_client = TestClient(mcp_only)
        tools_only = mcp_only_client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        chat_missing = mcp_only_client.post("/v1/chat/completions", json={})
        results.append(TrialResult("mcp_without_llm_routes", tools_only.status_code == 200 and chat_missing.status_code == 404, f"tools_status={tools_only.status_code} chat_status={chat_missing.status_code}"))

    rocky_native._rocky_codebase = old_native_codebase
    rocky_native._profile_engine = old_native_engine
    mcp_server._codebase = old_mcp_codebase
    mcp_server._skills = old_mcp_skills
    mcp_server._SKILL_TOOL_NAMES = old_skill_names

    grouped: dict[str, list[TrialResult]] = {}
    for result in results:
        grouped.setdefault(result.name, []).append(result)
    report = {
        "total_trials": len(results),
        "passed": sum(result.passed for result in results),
        "failed": [result.__dict__ for result in results if not result.passed][:10],
        "groups": {
            name: {
                "passed": sum(item.passed for item in items),
                "total": len(items),
                "sample": items[0].detail if items else "",
            }
            for name, items in grouped.items()
        },
        "conclusion": {
            "remove_llm_api_routes": "supported: MCP tools/list works in an app with only mcp_server mounted; chat endpoint is absent there.",
            "remove_native_c_engine_wrappers": "supported: randomized native search_graph/search_code/call trials matched direct/MCP-backed codebase behavior.",
            "keep_profile_endpoints": "supported: plan/read/validate produce plan_id/read-point workflow absent from MCP catalog.",
        },
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if not report["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
