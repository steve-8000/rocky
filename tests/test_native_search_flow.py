from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from rocky.core.routes import mcp_server, rocky_native


def test_runtime_root_uses_env_override(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ROCKY_RUNTIME_ROOT", str(tmp_path / ".rocky"))

    assert rocky_native._runtime_root() == (tmp_path / ".rocky").resolve()


def test_native_router_only_exposes_profile_surface() -> None:
    app = FastAPI()
    app.include_router(rocky_native.router)
    client = TestClient(app)

    assert client.get("/v1/codebase/status").status_code == 200
    assert client.get("/v1/codebase/profiles").status_code == 200
    assert client.get("/v1/codebase/health").status_code == 200

    removed = [
        ("get", "/v1/runtime/status"),
        ("post", "/v1/search"),
        ("post", "/v1/context/build"),
        ("post", "/v1/codebase/index"),
        ("post", "/v1/codebase/search_graph"),
        ("post", "/v1/codebase/search_code"),
        ("post", "/v1/codebase/call"),
        ("get", "/v1/rocky/codebase/status"),
        ("post", "/v1/rocky/codebase/plan"),
    ]
    for method, path in removed:
        response = client.request(method.upper(), path, json={} if method == "post" else None)
        assert response.status_code == 404, path


def test_mcp_router_keeps_index_control_plane() -> None:
    app = FastAPI()
    app.include_router(mcp_server.router)
    client = TestClient(app)

    response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})

    assert response.status_code == 200
    names = {tool["name"] for tool in response.json()["result"]["tools"]}
    assert {"index_repository", "detect_changes", "index_status"} <= names
    assert {"search_graph", "search_code", "get_code_snippet", "trace_path"} <= names
