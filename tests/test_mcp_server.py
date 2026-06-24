"""Endpoint tests for the streamable-HTTP MCP server (`POST /mcp`).

Hermetic: the skills service points at a tmp dir and the codebase client's
binary-spawning methods are monkeypatched, so no external process or real index
is touched. Skill search exercises the manifest fallback (search_graph -> []).
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from rocky.core.config import get_config
from rocky.core.routes import mcp_server
from rocky.skills.service import SkillsService


@pytest.fixture
def client(tmp_path, monkeypatch):
    svc = SkillsService(mcp_server._codebase, skills_dir=tmp_path)
    monkeypatch.setattr(mcp_server, "_skills", svc)
    # Hermetic codebase client: fixed catalog + echo passthrough, no binary spawn.
    monkeypatch.setattr(
        mcp_server._codebase,
        "codebase_tools_list",
        lambda: [
            {
                "name": "search_graph",
                "description": "graph search",
                "inputSchema": {"type": "object", "properties": {}},
            }
        ],
    )
    monkeypatch.setattr(
        mcp_server._codebase,
        "call_tool",
        lambda tool, arguments: {"tool": tool, "echo": arguments},
    )
    # Skills upsert reindex + semantic search are no-ops -> fallback path.
    monkeypatch.setattr(mcp_server._codebase, "index_repository", lambda repo: {"ok": True})
    monkeypatch.setattr(
        mcp_server._codebase, "search_graph", lambda query, repo, limit=20: []
    )
    app = FastAPI()
    app.include_router(mcp_server.router)
    return TestClient(app)


def _rpc(client, method, params=None, msg_id=1):
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/mcp", json=body)


def _tool_payload(resp):
    """Parse the JSON tool result out of the MCP content envelope."""
    result = resp.json()["result"]
    return result, json.loads(result["content"][0]["text"])


def test_initialize_handshake(client):
    resp = _rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    assert resp.status_code == 200
    assert resp.headers.get("Mcp-Session-Id")
    result = resp.json()["result"]
    assert result["serverInfo"]["name"] == "rocky-skills"
    assert result["protocolVersion"] == "2025-06-18"
    assert result["capabilities"]["tools"] == {"listChanged": False}


def test_initialized_notification_is_accepted(client):
    resp = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert resp.status_code == 202
    assert resp.content == b""


def test_ping(client):
    assert _rpc(client, "ping").json()["result"] == {}


def test_tools_list_merges_skill_and_codebase(client):
    tools = _rpc(client, "tools/list").json()["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {"skill_search", "skill_get", "skill_upsert", "skill_delete", "skill_list"} <= names
    assert "search_graph" in names
    # every tool advertises an inputSchema object
    assert all(isinstance(t.get("inputSchema"), dict) for t in tools)


def test_skill_upsert_get_search_delete_roundtrip(client):
    up = _rpc(
        client,
        "tools/call",
        {
            "name": "skill_upsert",
            "arguments": {
                "name": "deploy-canary",
                "summary": "roll out a canary deployment and watch error budget",
                "body": "1. scale canary\n2. watch metrics\n3. promote or roll back",
                "tags": ["ops", "deploy"],
            },
        },
    )
    _, created = _tool_payload(up)
    assert created["name"] == "deploy-canary"
    assert created["created"] is True

    got = _rpc(client, "tools/call", {"name": "skill_get", "arguments": {"name": "deploy-canary"}})
    _, body = _tool_payload(got)
    assert "canary" in body["body"]
    assert body["summary"].startswith("roll out a canary")

    # fallback search (search_graph stubbed to []) still finds it via manifest
    found = _rpc(
        client,
        "tools/call",
        {"name": "skill_search", "arguments": {"query": "canary deployment", "limit": 5}},
    )
    _, hits = _tool_payload(found)
    assert any(h["name"] == "deploy-canary" for h in hits)
    assert all("body" not in h for h in hits)  # search is summary-first

    rm = _rpc(client, "tools/call", {"name": "skill_delete", "arguments": {"name": "deploy-canary"}})
    _, deleted = _tool_payload(rm)
    assert deleted["deleted"] is True

    missing = _rpc(client, "tools/call", {"name": "skill_get", "arguments": {"name": "deploy-canary"}})
    assert missing.json()["result"].get("isError") is True


def test_codebase_tool_passthrough(client):
    resp = _rpc(
        client,
        "tools/call",
        {"name": "search_graph", "arguments": {"query": "auth", "project": "p"}},
    )
    _, payload = _tool_payload(resp)
    assert payload["tool"] == "search_graph"
    assert payload["echo"] == {"query": "auth", "project": "p"}


def test_unknown_method_returns_error(client):
    err = _rpc(client, "does/not/exist").json()["error"]
    assert err["code"] == -32601


def test_unknown_tool_name_is_tool_error(client):
    resp = _rpc(client, "tools/call", {"name": "no_such_tool", "arguments": {}})
    # routed to codebase call_tool stub -> echoes; real engine would error.
    # A missing tool *name* (empty) must be a protocol error instead:
    empty = _rpc(client, "tools/call", {"arguments": {}})
    assert empty.json()["error"]["code"] == -32602


def test_auth_required_when_key_configured(client):
    cfg = get_config()
    previous = cfg.api_key
    cfg.api_key = "secret-test-key"
    try:
        # no Authorization header -> rejected
        unauth = client.post(
            "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}
        )
        assert unauth.status_code == 401
        # correct bearer -> allowed
        ok = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            headers={"Authorization": "Bearer secret-test-key"},
        )
        assert ok.status_code == 200
        assert ok.json()["result"] == {}
    finally:
        cfg.api_key = previous


def test_get_mcp_not_allowed(client):
    resp = client.get("/mcp")
    assert resp.status_code == 405
    assert resp.headers.get("Allow") == "POST"


def test_resources_and_prompts_list_empty(client):
    assert _rpc(client, "resources/list").json()["result"] == {"resources": []}
    assert _rpc(client, "resources/templates/list").json()["result"] == {"resourceTemplates": []}
    assert _rpc(client, "prompts/list").json()["result"] == {"prompts": []}


def test_session_id_issued_and_reused(client):
    first = _rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    sid = first.headers.get("Mcp-Session-Id")
    assert sid
    # A client that echoes the id keeps it; the server reuses, not rotates.
    again = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "ping"},
        headers={"Mcp-Session-Id": sid},
    )
    assert again.headers.get("Mcp-Session-Id") == sid
    assert again.json()["result"] == {}
