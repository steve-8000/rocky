from __future__ import annotations

import asyncio
import json
from pathlib import Path

from rocky.core.routes import rocky_native
from rocky.search.codebase_memory import CodebaseCandidate
from rocky.search.fastcontext import FastContextCodebaseRunner


class FakeLLM:
    def __init__(self) -> None:
        self.calls = 0
        self.tool_names_by_call: list[list[str]] = []

    async def chat(self, messages, tools):
        self.calls += 1
        self.tool_names_by_call.append([tool["function"]["name"] for tool in tools])
        if self.calls == 1:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                _tool_call("1", "search_graph", {"query": "route", "limit": 3}),
                                _tool_call("2", "search_code", {"pattern": "rocky_search", "limit": 3}),
                            ],
                        }
                    }
                ]
            }
        if self.calls == 2:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                _tool_call("3", "glob", {"pattern": "**/*.py"}),
                                _tool_call("4", "grep", {"pattern": "def handler", "path": "."}),
                                _tool_call("5", "read", {"path": "app.py", "start_line": 1, "end_line": 2}),
                            ],
                        }
                    }
                ]
            }
        tool_results = "\n".join(message["content"] for message in messages if message["role"] == "tool")
        assert "app.py:1 graph-hit" in tool_results
        assert "app.py:3 code-hit" in tool_results
        assert "app.py lines 1-2" in tool_results
        return {"choices": [{"message": {"content": "<final_answer>\napp.py:1-2 - route\n</final_answer>"}}]}


class FakeCBM:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def search_graph(self, query, repo_path, limit=20):
        self.calls.append(("search_graph", query))
        return [CodebaseCandidate("app.py", 1, label="graph-hit")]

    def search_code(self, pattern, repo_path, limit=20):
        self.calls.append(("search_code", pattern))
        return [CodebaseCandidate("app.py", 3, label="code-hit")]


def _tool_call(call_id: str, name: str, arguments: dict) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def test_fastcontext_runner_executes_cbm_and_repository_tools(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("def handler():\n    return 'rocky_search'\n", encoding="utf-8")
    cbm = FakeCBM()
    llm = FakeLLM()
    runner = FastContextCodebaseRunner(cbm, llm=llm)

    result = asyncio.run(runner.search("where is rocky_search implemented", tmp_path))

    assert result.final_answer == "<final_answer>\napp.py:1-2 - route\n</final_answer>"
    assert result.turns == 3
    assert result.tool_messages == 5
    assert cbm.calls == [("search_graph", "route"), ("search_code", "rocky_search")]
    assert llm.tool_names_by_call[0] == ["search_graph", "search_code"]
    assert set(llm.tool_names_by_call[1]) == {"search_graph", "search_code", "glob", "grep", "read"}
    assert result.tool_names[:2] == ("search_graph", "search_code")


class ManyToolCallsLLM:
    async def chat(self, messages, tools):
        if tools:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                _tool_call(str(idx), "search_graph", {"query": f"route-{idx}", "limit": 50})
                                for idx in range(8)
                            ],
                        }
                    }
                ]
            }
        return {"choices": [{"message": {"content": "No citation"}}]}


def test_fastcontext_runner_bounds_parallel_tool_calls(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("def handler():\n    return 'ok'\n", encoding="utf-8")
    runner = FastContextCodebaseRunner(FakeCBM(), llm=ManyToolCallsLLM())

    result = asyncio.run(runner.search("find handler", tmp_path, max_turns=1))

    assert result.tool_messages == 8
    assert result.tool_names == (
        "search_graph",
        "search_graph",
        "search_graph",
        "search_graph",
        "search_graph",
        "search_graph",
        "search_graph",
        "search_graph",
    )


class NonCitingLLM:
    def __init__(self) -> None:
        self.calls = 0

    async def chat(self, messages, tools):
        self.calls += 1
        if self.calls == 1:
            return {"choices": [{"message": {"content": "", "tool_calls": [_tool_call("1", "read", {"path": "app.py", "start_line": 1, "end_line": 2})]}}]}
        return {"choices": [{"message": {"content": "I found the relevant file but forgot citations."}}]}


def test_fastcontext_runner_synthesizes_citations_from_tool_observations(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("def handler():\n    return 'ok'\n", encoding="utf-8")
    runner = FastContextCodebaseRunner(FakeCBM(), llm=NonCitingLLM())

    result = asyncio.run(runner.search("find handler", tmp_path))

    assert result.final_answer == "<final_answer>\napp.py:1-2 - tool evidence\n</final_answer>"


class NoToolFirstLLM:
    async def chat(self, messages, tools):
        if tools:
            return {"choices": [{"message": {"content": "No tool call"}}]}
        return {"choices": [{"message": {"content": "No citation"}}]}


def test_fastcontext_runner_primes_codebase_when_first_turn_has_no_tool_call(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("def handler():\n    return 'ok'\n", encoding="utf-8")
    runner = FastContextCodebaseRunner(FakeCBM(), llm=NoToolFirstLLM())

    result = asyncio.run(runner.search("find handler", tmp_path, max_turns=1))

    assert result.tool_names == ("search_graph",)
    assert result.final_answer == "<final_answer>\napp.py:1-1 - tool evidence\n</final_answer>"


class EmptyFastContext:
    async def search(self, query, path):
        return type("Result", (), {"final_answer": "", "turns": 1, "tool_messages": 0, "error": None, "tool_names": ()})()


class AnsweringFastContext:
    async def search(self, query, path):
        return type("Result", (), {"final_answer": "answer.py:7", "turns": 1, "tool_messages": 2, "error": None, "tool_names": ("search_graph", "read")})()


def test_search_targets_uses_fastcontext_before_codebase_fallback(monkeypatch) -> None:
    monkeypatch.setattr(rocky_native, "_fastcontext", AnsweringFastContext())
    monkeypatch.setattr(rocky_native, "_codebase_targets", lambda query, path: "fallback.py:1")
    request = rocky_native.SearchRequest(query="find route", path=".")

    result = asyncio.run(rocky_native._search_targets(request))

    assert result.final_answer == "answer.py:7"
    assert result.fastcontext_used is True
    assert result.fallback_used is False
    assert result.fastcontext_tool_names == ("search_graph", "read")
    assert request.turns == 1
    assert request.tool_messages == 2


def test_search_targets_falls_back_only_when_fastcontext_is_empty(monkeypatch) -> None:
    monkeypatch.setattr(rocky_native, "_fastcontext", EmptyFastContext())
    monkeypatch.setattr(rocky_native, "_codebase_targets", lambda query, path: "fallback.py:1")
    request = rocky_native.SearchRequest(query="find route", path=".")

    result = asyncio.run(rocky_native._search_targets(request))

    assert result.final_answer == "fallback.py:1"
    assert result.fastcontext_used is True
    assert result.fallback_used is True
    assert result.fastcontext_error == "fastcontext returned no final_answer"
