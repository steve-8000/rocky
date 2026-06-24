from __future__ import annotations

import asyncio
from pathlib import Path

from rocky.core.routes import rocky_native
from rocky.search.rocky_codebase import CodebaseCandidate


def test_search_targets_uses_codebase_fallback(monkeypatch) -> None:
    monkeypatch.setattr(rocky_native, "_codebase_targets", lambda query, path: "fallback.py:1")
    request = rocky_native.SearchRequest(query="find route", path=".")

    result = asyncio.run(rocky_native._search_targets(request))

    assert result.final_answer == "fallback.py:1"
    assert result.fallback_used is True


def test_search_targets_preserves_final_answer(monkeypatch) -> None:
    called = False

    def fail_if_called(query, path):
        nonlocal called
        called = True
        return "fallback.py:1"

    monkeypatch.setattr(rocky_native, "_codebase_targets", fail_if_called)
    request = rocky_native.SearchRequest(query="find route", path=".", final_answer="answer.py:7")

    result = asyncio.run(rocky_native._search_targets(request))

    assert result.final_answer == "answer.py:7"
    assert result.fallback_used is False
    assert called is False


def test_runtime_root_uses_env_override(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ROCKY_RUNTIME_ROOT", str(tmp_path / ".rocky"))

    assert rocky_native._runtime_root() == (tmp_path / ".rocky").resolve()


def test_runtime_status_uses_loaded_config(monkeypatch) -> None:
    class FakeConfig:
        model_name = "gemma-live"
        tool_call_parser = "qwen"
        ready = True

    monkeypatch.setattr(rocky_native, "get_config", lambda: FakeConfig())

    status = asyncio.run(rocky_native.runtime_status())

    assert status["modules"]["llm"] == {
        "model": "gemma-live",
        "tool_call_parser": "qwen",
        "port_ready": True,
    }


def test_runtime_status_falls_back_to_default_preset(monkeypatch) -> None:
    class FakeConfig:
        model_name = None
        tool_call_parser = "qwen"
        ready = True

    monkeypatch.setattr(rocky_native, "get_config", lambda: FakeConfig())

    status = asyncio.run(rocky_native.runtime_status())

    assert status["modules"]["llm"]["model"]


def test_codebase_search_graph_defaults_to_fifty_results() -> None:
    assert rocky_native.CodebaseSearchRequest(query="needle").limit == 50


def test_codebase_search_graph_returns_explicit_scope_metadata(monkeypatch, tmp_path: Path) -> None:
    root_a = tmp_path / "amaze"
    root_b = tmp_path / "rocky"
    root_a.mkdir()
    root_b.mkdir()

    class ScopedCodebase:
        def __init__(self) -> None:
            self.indexed: list[str] = []
            self.searched: list[str] = []

        def resolve_search_scope(self, *, path, cwd=None, scope="workspace", roots=None, max_parent_depth=None):
            return {
                "requested_scope": scope,
                "cwd": str(Path(cwd).resolve()),
                "workspace_path": str(Path(path).resolve()),
                "max_parent_depth": max_parent_depth,
                "effective_roots": [str(Path(root).resolve()) for root in roots],
                "searched_roots": [str(Path(root).resolve()) for root in roots],
                "excluded_roots": [],
            }

        def ensure_indexed(self, path):
            self.indexed.append(str(Path(path).resolve()))
            return {"ok": True, "project": str(path)}

        def search_graph(self, query, repo_path, limit=20):
            self.searched.append(str(Path(repo_path).resolve()))
            return [CodebaseCandidate(str(Path(Path(repo_path).name) / "app.py"), 1, label=query)]

    scoped = ScopedCodebase()
    monkeypatch.setattr(rocky_native, "_rocky_codebase", scoped)
    request = rocky_native.CodebaseSearchRequest(
        query="needle",
        path=str(root_a),
        cwd=str(root_a),
        scope="explicit_roots",
        roots=[str(root_a), str(root_b)],
        limit=2,
    )

    result = asyncio.run(rocky_native.codebase_search_graph(request))

    assert result["ok"] is True
    assert result["search_scope"]["effective_roots"] == [str(root_a.resolve()), str(root_b.resolve())]
    assert scoped.indexed == [str(root_a.resolve()), str(root_b.resolve())]
    assert scoped.searched == [str(root_a.resolve()), str(root_b.resolve())]
    assert [item["file_path"] for item in result["results"]] == ["amaze/app.py", "rocky/app.py"]
