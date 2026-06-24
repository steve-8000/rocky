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
    return json.loads(body["result"]["content"][0]["text"])


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


def fresh_import_probe(module: str) -> dict[str, Any]:
    code = f"""
import importlib, json, sys
HEAVY={HEAVY!r}
h=lambda: sorted({{m.split('.')[0] for m in sys.modules if m.split('.')[0] in HEAVY}})
before=h()
try:
    importlib.import_module({module!r})
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
    import_probe_app = fresh_import_probe("rocky.mcp_app")

    from rocky.core.routes import mcp_server, rocky_native

    app = FastAPI()
    app.include_router(mcp_server.router)
    app.include_router(rocky_native.router)
    client = TestClient(app)

    tools_response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    tools_response.raise_for_status()
    tool_names = sorted(tool["name"] for tool in tools_response.json()["result"]["tools"])

    removed_routes = [
        ("GET", "/v1/runtime/status"),
        ("POST", "/v1/search"),
        ("POST", "/v1/context/build"),
        ("POST", "/v1/codebase/index"),
        ("POST", "/v1/codebase/search_graph"),
        ("POST", "/v1/codebase/search_code"),
        ("POST", "/v1/codebase/call"),
        ("GET", "/v1/rocky/codebase/status"),
    ]
    removed_status = {f"{method} {path}": client.request(method, path, json={} if method == "POST" else None).status_code for method, path in removed_routes}

    required_tools = {"index_repository", "detect_changes", "index_status", "search_graph", "search_code", "get_code_snippet", "trace_path"}
    profile_status = {
        "status": client.get("/v1/codebase/status").status_code,
        "profiles": client.get("/v1/codebase/profiles").status_code,
        "health": client.get("/v1/codebase/health").status_code,
    }

    queries = ["ProfileBudget", "mcp_server", "search_graph", "to_search_json", "RockyProfileEngine"]
    mcp_trials: list[dict[str, Any]] = []
    for idx in range(20):
        query = rng.choice(queries)
        limit = rng.randint(1, 5)
        graph = mcp_tool(client, "search_graph", {"project": PROJECT, "query": query, "limit": limit})
        code = mcp_tool(client, "search_code", {"project": PROJECT, "pattern": query, "limit": limit, "mode": "compact"})
        mcp_trials.append(
            {
                "query": query,
                "limit": limit,
                "graph_ok": isinstance(graph, dict) and "results" in graph,
                "code_ok": isinstance(code, dict) and "results" in code,
            }
        )

    profile_trials: list[dict[str, Any]] = []
    for query in rng.sample(queries, 3):
        plan = client.post(
            "/v1/codebase/plan",
            json={
                "profile": "find_definition",
                "query": query,
                "scope": {"kind": "workspace", "cwd": str(ROOT), "path": str(ROOT)},
                "budget": {"max_primary_points": 3, "max_primary_files": 3, "max_primary_lines": 90, "max_total_response_chars": 10_000},
            },
        ).json()
        profile_trials.append({"query": query, "ok": plan.get("ok"), "has_plan_id": "plan_id" in plan, "primary": len(plan.get("primary", []))})

    report = {
        "mcp_tool_count": len(tool_names),
        "required_tools_present": sorted(required_tools & set(tool_names)),
        "missing_required_tools": sorted(required_tools - set(tool_names)),
        "removed_route_status": removed_status,
        "profile_status": profile_status,
        "import_weight": {"mcp_server": import_probe_mcp, "mcp_app": import_probe_app},
        "mcp_trials": {"passed": sum(item["graph_ok"] and item["code_ok"] for item in mcp_trials), "total": len(mcp_trials), "samples": mcp_trials[:5]},
        "profile_trials": profile_trials,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))

    success = (
        not report["missing_required_tools"]
        and all(status == 404 for status in removed_status.values())
        and all(status == 200 for status in profile_status.values())
        and report["mcp_trials"]["passed"] == report["mcp_trials"]["total"]
        and all(item["ok"] and item["has_plan_id"] for item in profile_trials)
    )
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
