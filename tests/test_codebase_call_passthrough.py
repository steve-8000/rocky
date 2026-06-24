from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from rocky.core.routes import rocky_native
from rocky.core.routes.rocky_native import CodebaseCallRequest
from rocky.search.rocky_codebase import RockyCodebaseClient, RockyCodebaseConfig


class FakeCallClient(RockyCodebaseClient):
    """Captures the tool/payload that reaches the rocky-codebase backend without
    shelling out to the real binary."""

    def __init__(self) -> None:
        super().__init__(RockyCodebaseConfig(enabled=True, auto_index=False))
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def ensure_indexed(self, repo_path: str | Path) -> dict[str, Any]:
        return {"ok": True, "skipped": True, "reason": "test"}

    def _call(self, tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((tool, payload))
        return {"tool": tool, "ok": True, "echo": payload}


def test_call_injects_project_derived_from_repo_path(tmp_path: Path) -> None:
    client = FakeCallClient()

    result = client.call("get_code_snippet", tmp_path, {"qualified_name": "Foo"})

    tool, payload = client.calls[0]
    assert tool == "get_code_snippet"
    assert payload["project"] == client.project_for_path(tmp_path)
    assert payload["qualified_name"] == "Foo"
    assert result["ok"] is True


def test_call_preserves_explicit_project(tmp_path: Path) -> None:
    client = FakeCallClient()

    client.call("trace_path", tmp_path, {"project": "explicit", "function_name": "foo"})

    _, payload = client.calls[0]
    assert payload["project"] == "explicit"


@pytest.mark.parametrize("tool", ["get_code_snippet", "trace_path", "get_architecture", "query_graph"])
def test_call_accepts_every_passthrough_tool(tmp_path: Path, tool: str) -> None:
    client = FakeCallClient()

    client.call(tool, tmp_path, {})

    assert client.calls[0][0] == tool


def test_call_rejects_unsupported_tool(tmp_path: Path) -> None:
    client = FakeCallClient()

    # search_graph/search_code/list_projects have their own dedicated routes and
    # must not be reachable through the generic passthrough.
    with pytest.raises(ValueError):
        client.call("search_graph", tmp_path, {})


def test_codebase_call_route_proxies_to_rocky_backend(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = FakeCallClient()
    monkeypatch.setattr(rocky_native, "_rocky_codebase", client)

    request = CodebaseCallRequest(
        tool="get_code_snippet",
        arguments={"qualified_name": "Foo"},
        path=str(tmp_path),
        cwd=str(tmp_path),
        scope="workspace",
    )

    result = asyncio.run(rocky_native.codebase_call(request))

    assert result["ok"] is True
    assert result["result"]["tool"] == "get_code_snippet"
    assert result["search_scope"]["effective_roots"] == [str(tmp_path.resolve())]
    tool, payload = client.calls[0]
    assert tool == "get_code_snippet"
    assert payload["project"] == client.project_for_path(tmp_path)


def test_codebase_call_route_reports_unsupported_tool(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = FakeCallClient()
    monkeypatch.setattr(rocky_native, "_rocky_codebase", client)

    request = CodebaseCallRequest(tool="search_graph", path=str(tmp_path), cwd=str(tmp_path))

    result = asyncio.run(rocky_native.codebase_call(request))

    assert result["ok"] is False
    assert "unsupported" in result["error"]
    assert client.calls == []
