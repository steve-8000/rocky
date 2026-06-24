from __future__ import annotations

import os
import sys
from dataclasses import dataclass


@dataclass
class Preset:
    alias: str
    prefill_step_size: int = 4096
    max_tokens: int = 8192
    no_thinking: bool = False
    mllm: bool = False
    tool_call_parser: str | None = None


PRESETS: dict[str, Preset] = {
    "gemma4-12b": Preset(
        alias="gemma-4-12b-qat-4bit",
        prefill_step_size=4096,
        max_tokens=32768,
        no_thinking=True,
    ),
    "qwen3.6-27b": Preset(
        alias="qwen3.6-27b-4bit",
        prefill_step_size=4096,
        max_tokens=32768,
    ),
    "qwen3.6-35b": Preset(
        alias="qwen3.6-35b-4bit",
        prefill_step_size=8192,
        max_tokens=32768,
    ),
    "qwen-fable-9b": Preset(
        alias="qwen-fable-9b-8bit",
        prefill_step_size=4096,
        max_tokens=32768,
    ),
}

DEFAULT_PRESET = "gemma4-12b"


def _env(key: str, fallback: str) -> str:
    return os.environ.get(key, fallback)


def run(
    preset_name: str | None = None,
    host: str | None = None,
    port: int | None = None,
    api_key: str | None = None,
    mcp: bool | None = None,
    skills_dir: str | None = None,
    extra: list[str] | None = None,
) -> None:
    """Launch the lightweight MCP-only Rocky app.

    The ``preset_name`` and ``extra`` parameters are accepted for CLI
    compatibility with the 0.1.0 baseline, but 0.1.1 no longer exposes LLM
    HTTP routes from this entrypoint.
    """
    if preset_name and preset_name not in PRESETS:
        print(f"Unknown preset '{preset_name}'. Available: {', '.join(PRESETS)}", file=sys.stderr)
        sys.exit(1)

    host = host or _env("ROCKY_HOST", "127.0.0.1")
    port = port or int(_env("ROCKY_PORT", "7777"))
    api_key = api_key or _env("ROCKY_API_KEY", "") or None

    if skills_dir:
        os.environ["ROCKY_SKILLS_DIR"] = skills_dir
    if mcp is False:
        print("Rocky 0.1.1 only serves the MCP endpoint; --no-mcp would disable the service.", file=sys.stderr)
        sys.exit(1)

    if extra:
        print(f"Ignoring unsupported legacy serve args: {' '.join(extra)}", file=sys.stderr)

    import uvicorn
    from rocky.core.config import get_config
    from rocky.mcp_app import create_app

    if api_key:
        get_config().api_key = api_key

    print(f"rocky serve → MCP skills+codebase server {host}:{port}")
    uvicorn.run(create_app(), host=host, port=port, log_level="warning")
