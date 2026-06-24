# SPDX-License-Identifier: Apache-2.0
"""Lightweight ASGI entrypoint for the standalone Skills+Codebase MCP server.

This is the *ML-free* face of rocky: it mounts only the streamable-HTTP MCP
endpoint (``/mcp``) plus a readiness probe. It deliberately avoids
``rocky.core.server`` (which loads the MLX model stack) so the image can run on
a non-Metal host such as a Linux container VM.

Run it with::

    uvicorn rocky.mcp_app:app --host 0.0.0.0 --port 7777

Environment:
    ROCKY_SKILLS_DIR        directory of ``<name>/SKILL.md`` skills (default ~/.rocky/skills)
    ROCKY_API_KEY           if set, clients must send ``Authorization: Bearer <key>``
    ROCKY_CODEBASE_BINARY   path to the ``rocky-codebase`` engine binary (optional;
                            codebase tools degrade gracefully when absent)
"""

from __future__ import annotations

import os

from fastapi import FastAPI

from rocky.core.config import get_config
from rocky.core.routes.mcp_server import router as mcp_router


def create_app() -> FastAPI:
    """Build the minimal MCP-only FastAPI app (no model engine).

    Honors ``ROCKY_API_KEY`` directly: the bare app never runs ``serve.run()``,
    so we wire the bearer-token requirement into the shared ServerConfig here.
    Without this the container would silently serve with auth disabled.
    """
    api_key = os.getenv("ROCKY_API_KEY") or None
    if api_key:
        get_config().api_key = api_key

    app = FastAPI(
        title="Rocky Skills+Codebase MCP",
        description="Spec-compliant streamable-HTTP MCP server for external agents.",
        version="0.1.1",
    )
    app.include_router(mcp_router)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:  # pragma: no cover - trivial probe
        return {"status": "ok"}

    return app


app = create_app()
