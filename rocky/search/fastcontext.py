from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx

from rocky.search.codebase_memory import CodebaseMemoryClient
from rocky.search.tools import RepositoryTools
from rocky.serve import PRESETS


_DEFAULT_MAX_TURNS = 6
_MAX_TOOL_CALLS_PER_TURN = int(os.getenv("ROCKY_FASTCONTEXT_MAX_TOOL_CALLS_PER_TURN", "8"))
_MAX_TOOL_OBSERVATION_CHARS = int(os.getenv("ROCKY_FASTCONTEXT_MAX_OBSERVATION_CHARS", "12000"))
_MAX_CANDIDATES_PER_CODEBASE_TOOL = int(os.getenv("ROCKY_FASTCONTEXT_MAX_CODEBASE_CANDIDATES", "20"))


class FastContextLLM(Protocol):
    async def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        ...


@dataclass(frozen=True)
class FastContextResult:
    final_answer: str
    turns: int
    tool_messages: int
    error: str | None = None
    tool_names: tuple[str, ...] = ()


class InProcessFastContextLLM:
    async def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        from rocky.core import server as rocky_server

        headers: dict[str, str] = {}
        api_key = getattr(rocky_server, "_api_key", None)
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        payload: dict[str, Any] = {
            "model": PRESETS["fastcontext"].alias,
            "messages": messages,
            "temperature": 0,
            "max_tokens": 1024,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
            payload["parallel_tool_calls"] = True
        transport = httpx.ASGITransport(app=rocky_server.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://rocky.local", headers=headers) as client:
            response = await client.post("/v1/chat/completions", json=payload)
            response.raise_for_status()
            return response.json()


class FastContextCodebaseRunner:
    def __init__(self, cbm: CodebaseMemoryClient, llm: FastContextLLM | None = None) -> None:
        self.cbm = cbm
        self.llm = llm or InProcessFastContextLLM()

    async def search(self, query: str, repo_path: str | Path, *, max_turns: int = _DEFAULT_MAX_TURNS) -> FastContextResult:
        repo = Path(repo_path).expanduser().resolve()
        tools = RepositoryTools(repo)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Repository: {repo.as_posix()}\n"
                    f"Query: {query}\n\n"
                    "Use the available codebase tools first. Return only a <final_answer> block "
                    "with file paths and line ranges."
                ),
            },
        ]
        tool_messages = 0
        turns = 0
        final_answer = ""
        observations: list[str] = []
        tool_names: list[str] = []
        for _ in range(max_turns):
            turns += 1
            available_tools = _codebase_tool_definitions() if turns == 1 else _tool_definitions()
            response = await self.llm.chat(messages, available_tools)
            message = _response_message(response)
            tool_calls = message.get("tool_calls") or []
            content = message.get("content") or ""
            if turns == 1 and not tool_calls:
                tool_calls = [_synthetic_tool_call("search_graph", {"query": query, "limit": 20})]
                content = content or ""
            if not tool_calls:
                final_answer = content
                break
            tool_calls = _bounded_tool_calls(tool_calls)
            messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
            for call in tool_calls:
                tool_messages += 1
                tool_names.append(_tool_name(call))
                result = _truncate_observation(self._execute_tool(call, repo, tools))
                observations.append(result)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id", f"call_{tool_messages}"),
                        "name": _tool_name(call),
                        "content": result,
                    }
                )
        if not final_answer and tool_messages:
            turns += 1
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Stop exploring. Using only the tool observations above, return the final citations now. "
                        "Return only a <final_answer> block with existing repository file paths and line ranges."
                    ),
                }
            )
            response = await self.llm.chat(messages, [])
            final_answer = (_response_message(response).get("content") or "").strip()
        if not _has_existing_file_refs(final_answer, repo):
            synthesized = _synthesize_final_answer(observations)
            if synthesized:
                final_answer = synthesized
        return FastContextResult(
            final_answer=final_answer.strip(),
            turns=turns,
            tool_messages=tool_messages,
            tool_names=tuple(tool_names),
        )

    def _execute_tool(self, call: dict[str, Any], repo: Path, tools: RepositoryTools) -> str:
        name = _tool_name(call)
        args = _tool_args(call)
        try:
            if name == "search_graph":
                limit = min(int(args.get("limit") or _MAX_CANDIDATES_PER_CODEBASE_TOOL), _MAX_CANDIDATES_PER_CODEBASE_TOOL)
                return _format_candidates(self.cbm.search_graph(str(args.get("query") or ""), repo, limit=limit))
            if name == "search_code":
                limit = min(int(args.get("limit") or _MAX_CANDIDATES_PER_CODEBASE_TOOL), _MAX_CANDIDATES_PER_CODEBASE_TOOL)
                return _format_candidates(self.cbm.search_code(str(args.get("pattern") or ""), repo, limit=limit))
            if name == "glob":
                return tools.glob(str(args.get("pattern") or "*"))
            if name == "grep":
                return tools.grep(str(args.get("pattern") or ""), str(args.get("path") or "."))
            if name == "read":
                return tools.read(
                    str(args.get("path") or ""),
                    start_line=int(args.get("start_line") or 1),
                    end_line=(int(args["end_line"]) if args.get("end_line") is not None else None),
                )
        except Exception as exc:
            return f"{name} failed: {exc}"
        return f"Unknown tool: {name}"


def _bounded_tool_calls(tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return tool_calls[:_MAX_TOOL_CALLS_PER_TURN]


def _truncate_observation(text: str) -> str:
    if len(text) <= _MAX_TOOL_OBSERVATION_CHARS:
        return text
    return text[:_MAX_TOOL_OBSERVATION_CHARS] + "\n...[truncated]"


def _response_message(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices") or []
    if not choices:
        return {}
    message = choices[0].get("message") or {}
    return message if isinstance(message, dict) else {}


def _tool_name(call: dict[str, Any]) -> str:
    function = call.get("function") or {}
    return str(function.get("name") or call.get("name") or "")


def _tool_args(call: dict[str, Any]) -> dict[str, Any]:
    function = call.get("function") or {}
    raw = function.get("arguments") or call.get("arguments") or "{}"
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(str(raw))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _synthetic_tool_call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "call_codebase_primer",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def _format_candidates(candidates: list[Any]) -> str:
    lines: list[str] = []
    for candidate in candidates:
        target = candidate.target()
        label = getattr(candidate, "label", None) or getattr(candidate, "name", None) or ""
        lines.append(f"{target} {label}".strip())
    return "\n".join(lines) if lines else "No codebase-memory results."


def _has_existing_file_refs(text: str, repo: Path) -> bool:
    for match in re.finditer(r"(?P<path>[\w./-]+\.\w+):\d+", text):
        raw_path = match.group("path")
        path = Path(raw_path)
        candidate = path if path.is_absolute() else repo / raw_path
        if candidate.exists() and candidate.is_file():
            return True
    return False


def _synthesize_final_answer(observations: list[str]) -> str:
    seen: set[str] = set()
    refs: list[str] = []
    patterns = (
        re.compile(r"(?P<path>[\w./-]+\.\w+):(?P<line>\d+)"),
        re.compile(r"(?P<path>[\w./-]+\.\w+) lines (?P<line>\d+)-(?P<end>\d+)"),
    )
    for observation in observations:
        for pattern in patterns:
            for match in pattern.finditer(observation):
                path = match.group("path")
                if path.startswith(".amaze-work/") or "/.amaze-work/" in path:
                    continue
                start = match.group("line")
                end = match.groupdict().get("end") or start
                ref = f"{path}:{start}-{end}"
                if ref in seen:
                    continue
                seen.add(ref)
                refs.append(f"{ref} - tool evidence")
                if len(refs) >= 8:
                    return "<final_answer>\n" + "\n".join(refs) + "\n</final_answer>"
    if not refs:
        return ""
    return "<final_answer>\n" + "\n".join(refs) + "\n</final_answer>"


def _tool_definitions() -> list[dict[str, Any]]:
    return [
        *_codebase_tool_definitions(),
        *_repository_tool_definitions(),
    ]


def _codebase_tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "search_graph",
                "description": "Search the codebase-memory graph for relevant symbols, routes, and files.",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 20}},
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_code",
                "description": "Search codebase-memory lexical/code index with a pattern.",
                "parameters": {
                    "type": "object",
                    "properties": {"pattern": {"type": "string"}, "limit": {"type": "integer", "default": 20}},
                    "required": ["pattern"],
                },
            },
        },
    ]


def _repository_tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "glob",
                "description": "List repository files matching a glob pattern.",
                "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search repository files with a regular expression.",
                "parameters": {
                    "type": "object",
                    "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "default": "."}},
                    "required": ["pattern"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a bounded file line range from the repository.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "start_line": {"type": "integer", "default": 1},
                        "end_line": {"type": "integer"},
                    },
                    "required": ["path"],
                },
            },
        },
    ]


_SYSTEM_PROMPT = """You are FastContext, a repository-exploration subagent.
Use codebase-memory and repository READ/GLOB/GREP tools to find grounded code evidence.
Do not answer the user's engineering task directly.
Return only:
<final_answer>
path/to/file.py:start-end - why this range is relevant
</final_answer>
"""
