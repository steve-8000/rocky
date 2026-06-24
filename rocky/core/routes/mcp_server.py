"""Streamable-HTTP MCP server endpoint for external agents.

Exposes a spec-aligned Model Context Protocol server at ``POST /mcp`` so any
external MCP client (Claude, Cursor, Codex, custom agents) can use Rocky as a
tool server over HTTP. The advertised tool catalog merges:

* 5 **skill** tools (``skill_search``/``skill_get``/``skill_upsert``/
  ``skill_delete``/``skill_list``) backed by Rocky's existing codebase semantic
  index over a skills directory (no separate indexer) — see
  ``rocky/skills/service.py``.
* All codebase tools from the C engine (``search_graph``, ``trace_path``,
  ``get_code_snippet``, ...), sourced from the engine itself and proxied as-is.

Transport: JSON-RPC 2.0 over HTTP POST. Single responses use ``application/json``
(the spec permits this in place of an SSE stream for request/response tools).
``Mcp-Session-Id`` is issued on every response; notifications (no ``id``) get
``202 Accepted`` with no body. Auth reuses the server-wide bearer key.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse

from rocky.core.middleware.auth import verify_api_key
from rocky.search.rocky_codebase import get_rocky_codebase_client
from rocky.skills.service import SKILL_TOOLS, SkillsService

logger = logging.getLogger(__name__)

router = APIRouter()

# MCP protocol version we implement; we echo the client's requested version when
# present so newer clients negotiating an older/newer revision still connect.
_PROTOCOL_VERSION = "2025-06-18"
_SERVER_INFO = {"name": "rocky-skills", "version": "0.1.0"}

_codebase = get_rocky_codebase_client()
_skills = SkillsService(_codebase)

_SKILL_TOOL_NAMES = {tool["name"] for tool in SKILL_TOOLS}

# In-memory session lifecycle: ``initialize`` mints an ``Mcp-Session-Id`` that the
# client echoes on later calls. We record last-seen time and purge idle sessions so
# the registry never grows unbounded. Handling stays lenient — an unknown id is
# adopted rather than rejected (404) — so simple/stateless clients keep working.
_SESSION_TTL_SECONDS = 3600.0
_sessions: dict[str, float] = {}


def _touch_session(session_id: str) -> None:
    """Record ``session_id`` as live now and drop sessions idle past the TTL."""
    now = time.monotonic()
    if _sessions:
        stale = [sid for sid, seen in _sessions.items() if now - seen > _SESSION_TTL_SECONDS]
        for sid in stale:
            _sessions.pop(sid, None)
    _sessions[session_id] = now


def _tool_catalog() -> list[dict[str, Any]]:
    """Merged MCP tool list: local skill tools + proxied C-engine codebase tools."""
    tools: list[dict[str, Any]] = list(SKILL_TOOLS)
    try:
        tools.extend(_codebase.codebase_tools_list())
    except Exception:  # pragma: no cover - defensive; client already swallows
        logger.warning("codebase tools_list failed", exc_info=True)
    return tools


def _ok(msg_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _err(msg_id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": msg_id, "error": error}


def _content(payload: Any) -> dict[str, Any]:
    """Wrap a tool result in the MCP ``content`` envelope (single text block)."""
    text = (
        payload
        if isinstance(payload, str)
        else json.dumps(payload, ensure_ascii=False, default=str)
    )
    return {"content": [{"type": "text", "text": text}]}


def _tool_error(msg_id: Any, message: str) -> dict[str, Any]:
    """A tool-level failure: a successful JSON-RPC result flagged ``isError``."""
    return _ok(msg_id, {**_content({"error": message}), "isError": True})


def _handle_message(msg: Any) -> dict[str, Any] | None:
    """Handle one JSON-RPC message. Returns a response, or ``None`` for a
    notification (a message with no ``id``) that needs no reply."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        msg_id = msg.get("id") if isinstance(msg, dict) else None
        return _err(msg_id, -32600, "invalid request")

    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}
    is_notification = "id" not in msg

    if method == "initialize":
        return _ok(
            msg_id,
            {
                "protocolVersion": params.get("protocolVersion") or _PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": _SERVER_INFO,
            },
        )

    # Client lifecycle / housekeeping notifications — acknowledged with no body.
    if method in ("notifications/initialized", "initialized", "notifications/cancelled"):
        return None

    if method == "ping":
        return _ok(msg_id, {})

    if method == "tools/list":
        return _ok(msg_id, {"tools": _tool_catalog()})

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if not name:
            return _err(msg_id, -32602, "missing tool name")
        try:
            if name in _SKILL_TOOL_NAMES:
                result = _skills.dispatch(name, arguments)
            else:
                result = _codebase.call_tool(name, arguments)
        except ValueError as exc:
            return _err(msg_id, -32602, str(exc))
        except KeyError as exc:
            return _tool_error(msg_id, f"not found: {exc}")
        except Exception as exc:  # tool runtime failure -> isError result
            logger.warning("tools/call %s failed", name, exc_info=True)
            return _tool_error(msg_id, str(exc))
        return _ok(msg_id, _content(result))

    # Resource/prompt surfaces: we expose tools only, but answer the discovery
    # probes some clients send regardless with empty lists instead of an error.
    if method == "resources/list":
        return _ok(msg_id, {"resources": []})

    if method == "resources/templates/list":
        return _ok(msg_id, {"resourceTemplates": []})

    if method == "prompts/list":
        return _ok(msg_id, {"prompts": []})

    if is_notification:
        return None
    return _err(msg_id, -32601, f"method not found: {method}")


@router.post("/mcp", dependencies=[Depends(verify_api_key)])
async def mcp_endpoint(request: Request) -> Response:
    """Streamable-HTTP MCP entrypoint. Accepts a single JSON-RPC object or a
    batch array; replies with ``application/json`` (or ``202`` for a pure
    notification batch)."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(_err(None, -32700, "parse error"), status_code=400)

    session_id = request.headers.get("mcp-session-id") or uuid.uuid4().hex
    _touch_session(session_id)
    headers = {"Mcp-Session-Id": session_id}

    if isinstance(body, list):
        if not body:
            return JSONResponse(_err(None, -32600, "empty batch"), status_code=400)
        responses = [r for r in (_handle_message(m) for m in body) if r is not None]
        if not responses:
            return Response(status_code=202, headers=headers)
        return JSONResponse(responses, headers=headers)

    response = _handle_message(body)
    if response is None:
        return Response(status_code=202, headers=headers)
    return JSONResponse(response, headers=headers)


@router.get("/mcp")
async def mcp_get() -> Response:
    """Rocky does not push server-initiated SSE; the spec permits 405 here."""
    return Response(status_code=405, headers={"Allow": "POST"})
