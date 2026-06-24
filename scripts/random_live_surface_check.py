from __future__ import annotations

import importlib
import json
import random
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient

PROJECT = "Users-steve-amaze_s3-rocky"
ROOT = Path(__file__).resolve().parents[1]
HEAVY = ("mlx", "mlx_lm", "mlx_vlm", "torch", "torchvision", "outlines", "transformers", "cv2", "PIL")


def _json_from_mcp(response) -> Any:
    response.raise_for_status()
    body = response.json()
    if "error" in body:
        raise RuntimeError(body["error"])
    text = body["result"]["content"][0]["text"]
    return json.loads(text)


def mcp_tool(client: TestClient, name: str, arguments: dict[str, Any]) -> Any:
    return _json_from_mcp(
        client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": random.randint(1, 1_000_000),
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )
    )


def result_paths(payload: Any) -> list[str]:
    results = payload.get("results", []) if isinstance(payload, dict) else []
    paths: list[str] = []
    for item in results:
        path = item.get("file_path") or item.get("file")
        if path:
            paths.append(str(path))
    return paths


def fresh_import_probe(module: str) -> dict[str, Any]:
    code = f"""
import importlib, json, sys
HEAVY={HEAVY!r}
h=lambda: sorted({{m.split('.')[0] for m in sys.modules if m.split('.')[0] in HEAVY}})
before=h()
try:
    mod=importlib.import_module({module!r})
    ok=True
    err=None
except Exception as exc:
    ok=False
    err=type(exc).__name__ + ': ' + str(exc)
print(json.dumps({{'module': {module!r}, 'ok': ok, 'error': err, 'heavy_added': sorted(set(h())-set(before)), 'heavy_loaded': h()}}))
"""
    completed = subprocess.run([sys.executable, "-c", code], cwd=ROOT, text=True, capture_output=True, timeout=30, check=True)
    return json.loads(completed.stdout.strip().splitlines()[-1])


def main() -> int:
    rng = random.Random(20260624)

    import_probe_mcp = fresh_import_probe("rocky.core.routes.mcp_server")
    import_probe_server = fresh_import_probe("rocky.core.server")

    from rocky.core.routes import mcp_server, rocky_native

    mcp_app = FastAPI()
    mcp_app.include_router(mcp_server.router)
    mcp_client = TestClient(mcp_app)

    native_app = FastAPI()
    native_app.include_router(rocky_native.router)
    native_client = TestClient(native_app)

    tools_response = mcp_client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    tools_response.raise_for_status()
    tools = tools_response.json()["result"]["tools"]
    tool_names = sorted(tool["name"] for tool in tools)

    # MCP-only app proves the tool server does not need OpenAI/LLM HTTP routes mounted.
    missing_chat = mcp_client.post("/v1/chat/completions", json={})
    missing_models = mcp_client.get("/v1/models")

    projects = mcp_tool(mcp_client, "list_projects", {})
    indexed_projects = [item.get("name") for item in projects.get("projects", [])]

    queries = [
        "FastContext",
        "codebase plan",
        "skill_search",
        "runtime status",
        "ProfileBudget",
        "mcp_server",
        "search_graph",
        "to_search_json",
        "DEFAULT_PRESET",
        "RockyProfileEngine",
    ]
    path_filters = [None, "rocky/search", "rocky/core/routes", "tests", "scripts"]

    trials: list[dict[str, Any]] = []
    for idx in range(30):
        query = rng.choice(queries)
        limit = rng.randint(1, 8)
        native = native_client.post(
            "/v1/codebase/search_graph",
            json={"query": query, "path": str(ROOT), "cwd": str(ROOT), "scope": "workspace", "limit": limit},
        ).json()
        mcp = mcp_tool(mcp_client, "search_graph", {"project": PROJECT, "query": query, "limit": limit})
        native_paths = [item["file_path"] for item in native.get("results", [])]
        mcp_paths = result_paths(mcp)
        trials.append(
            {
                "kind": "search_graph_overlap",
                "query": query,
                "limit": limit,
                "native_status": native.get("ok"),
                "native_count": len(native_paths),
                "mcp_count": len(mcp_paths),
                "same_prefix": native_paths[: min(3, len(native_paths), len(mcp_paths))] == mcp_paths[: min(3, len(native_paths), len(mcp_paths))],
            }
        )

        pattern = rng.choice(queries)
        native_code = native_client.post(
            "/v1/codebase/search_code",
            json={"pattern": pattern, "path": str(ROOT), "cwd": str(ROOT), "scope": "workspace", "limit": limit},
        ).json()
        mcp_code_args: dict[str, Any] = {"project": PROJECT, "pattern": pattern, "limit": limit, "mode": "compact"}
        path_filter = rng.choice(path_filters)
        if path_filter:
            mcp_code_args["path_filter"] = path_filter
        mcp_code = mcp_tool(mcp_client, "search_code", mcp_code_args)
        trials.append(
            {
                "kind": "search_code_overlap",
                "pattern": pattern,
                "limit": limit,
                "native_status": native_code.get("ok"),
                "native_count": len(native_code.get("results", [])),
                "mcp_total_results": mcp_code.get("total_results"),
                "mcp_result_count": len(mcp_code.get("results", [])),
            }
        )

    # Unique native profile flow: there is no MCP codebase_plan tool in the actual MCP catalog.
    profile_trials: list[dict[str, Any]] = []
    for query in rng.sample(queries, 5):
        plan = native_client.post(
            "/v1/codebase/plan",
            json={
                "profile": "find_definition",
                "query": query,
                "scope": {"kind": "workspace", "cwd": str(ROOT), "path": str(ROOT)},
                "budget": {"max_primary_points": 3, "max_primary_files": 3, "max_primary_lines": 90, "max_total_response_chars": 10_000},
            },
        ).json()
        entry = {"query": query, "ok": plan.get("ok"), "has_plan_id": "plan_id" in plan, "primary": len(plan.get("primary", []))}
        if plan.get("primary"):
            point_id = plan["primary"][0]["point_id"]
            read = native_client.post("/v1/codebase/read", json={"plan_id": plan["plan_id"], "point_ids": [point_id]}).json()
            validate = native_client.post("/v1/codebase/validate_points", json={"plan_id": plan["plan_id"], "point_ids": [point_id]}).json()
            entry["read_ok"] = read.get("ok")
            entry["validate_fresh"] = bool(validate.get("points") and validate["points"][0].get("fresh"))
        profile_trials.append(entry)

    graph_ok = sum(1 for item in trials if item["kind"] == "search_graph_overlap" and item["native_status"] is True and item["mcp_count"] >= 0)
    code_ok = sum(1 for item in trials if item["kind"] == "search_code_overlap" and item["native_status"] is True and item["mcp_result_count"] >= 0)
    profile_ok = sum(1 for item in profile_trials if item.get("ok") is True and item.get("has_plan_id") is True)

    report = {
        "real_backend": True,
        "project": PROJECT,
        "indexed_projects_contains_project": PROJECT in indexed_projects,
        "mcp_tool_count": len(tool_names),
        "mcp_tool_sample": tool_names[:20],
        "mcp_only_app": {"tools_list_status": tools_response.status_code, "chat_status": missing_chat.status_code, "models_status": missing_models.status_code},
        "import_weight": {"mcp_server": import_probe_mcp, "full_server": import_probe_server},
        "random_trials": {"search_graph_passed": graph_ok, "search_code_passed": code_ok, "total_each": 30, "samples": trials[:6]},
        "profile_trials": {"passed": profile_ok, "total": len(profile_trials), "samples": profile_trials},
        "mcp_catalog_has_profile_plan": any(name in tool_names for name in ["codebase_plan", "codebase_read", "codebase_expand", "codebase_validate"]),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))

    success = (
        report["indexed_projects_contains_project"]
        and tools_response.status_code == 200
        and missing_chat.status_code == 404
        and missing_models.status_code == 404
        and graph_ok == 30
        and code_ok == 30
        and profile_ok >= 1
        and not report["mcp_catalog_has_profile_plan"]
    )
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
