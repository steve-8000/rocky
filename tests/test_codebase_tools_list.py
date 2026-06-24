from __future__ import annotations

from pathlib import Path

import pytest

from rocky.search.rocky_codebase import RockyCodebaseClient, RockyCodebaseConfig


_BINARY = Path(__file__).resolve().parents[1] / "bin" / "rocky-codebase"


def _client_or_skip() -> RockyCodebaseClient:
    if not _BINARY.exists():
        pytest.skip("rocky-codebase binary not available")
    return RockyCodebaseClient(
        RockyCodebaseConfig(
            enabled=True,
            auto_index=False,
            binary=str(_BINARY),
        )
    )


def test_codebase_tools_list_reads_engine_tools() -> None:
    client = _client_or_skip()

    tools = client.codebase_tools_list()

    assert len(tools) >= 8
    assert any(
        tool.get("name") == "search_graph" and isinstance(tool.get("inputSchema"), dict)
        for tool in tools
    )


def test_call_tool_proxies_generic_engine_tool() -> None:
    client = _client_or_skip()

    result = client.call_tool("list_projects", {})

    assert isinstance(result, dict)
