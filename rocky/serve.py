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
    embedding_model: str | None = None
    tool_call_parser: str | None = None


EMBEDDING_PRESETS: dict[str, str] = {
    "qwen3-embed-0.6b": "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ",
    "qwen3-embed-4b":   "mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
    "qwen3-embed-8b":   "mlx-community/Qwen3-Embedding-8B-4bit-DWQ",
    "nomic":            "mlx-community/nomicai-modernbert-embed-base-4bit",
    "gemma-embed":      "mlx-community/embeddinggemma-300m-4bit",
}

EMBEDDING_MODEL_DEFAULT = EMBEDDING_PRESETS["qwen3-embed-0.6b"]

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
    "fastcontext": Preset(
        alias="microsoft/FastContext-1.0-4B-SFT",
        prefill_step_size=4096,
        max_tokens=8192,
        tool_call_parser="qwen",
    ),
}

DEFAULT_PRESET = "fastcontext"


def _env(key: str, fallback: str) -> str:
    return os.environ.get(key, fallback)


def run(
    preset_name: str | None = None,
    host: str | None = None,
    port: int | None = None,
    api_key: str | None = None,
    embedding_model: str | None = None,
    extra: list[str] | None = None,
) -> None:
    preset_name = preset_name or _env("ROCKY_PRESET", DEFAULT_PRESET)
    if preset_name not in PRESETS:
        print(f"Unknown preset '{preset_name}'. Available: {', '.join(PRESETS)}", file=sys.stderr)
        sys.exit(1)

    preset = PRESETS[preset_name]
    host = host or _env("ROCKY_HOST", "127.0.0.1")
    port = port or int(_env("ROCKY_PORT", "30000"))
    api_key = api_key or _env("ROCKY_API_KEY", "") or None
    embedding_model = embedding_model or _env("ROCKY_EMBEDDING_MODEL", "") or None

    import uvicorn
    from rocky.core import server as _server
    from rocky.core.model_aliases import resolve_profile
    from rocky.core.scheduler import SchedulerConfig

    _server._no_thinking = preset.no_thinking
    _server._api_key = api_key
    _server._model_alias = preset.alias

    profile = resolve_profile(preset.alias)
    model_name = profile.hf_path if profile else preset.alias

    from rocky.core.model_auto_config import detect_model_config
    auto_cfg = detect_model_config(model_name)
    if preset.tool_call_parser:
        _server._tool_call_parser = preset.tool_call_parser
        _server._enable_auto_tool_choice = True
    elif auto_cfg and auto_cfg.tool_call_parser:
        _server._tool_call_parser = auto_cfg.tool_call_parser
        _server._enable_auto_tool_choice = True

    scheduler_config = SchedulerConfig(prefill_step_size=preset.prefill_step_size)

    print(f"rocky serve → {preset_name} ({preset.alias}) {host}:{port}  tool_parser={_server._tool_call_parser}")

    _server.load_model(
        model_name=model_name,
        scheduler_config=scheduler_config,
        max_tokens=preset.max_tokens,
        force_mllm=preset.mllm,
    )

    if embedding_model:
        _server.load_embedding_model(embedding_model, lock=True)

    uvicorn.run(_server.app, host=host, port=port, log_level="warning")


def run_embed(
    preset_name: str | None = None,
    host: str | None = None,
    port: int | None = None,
    api_key: str | None = None,
) -> None:
    preset_name = preset_name or _env("ROCKY_EMBED_PRESET", "qwen3-embed-0.6b")
    if preset_name not in EMBEDDING_PRESETS:
        print(f"Unknown embedding preset '{preset_name}'. Available: {', '.join(EMBEDDING_PRESETS)}", file=sys.stderr)
        sys.exit(1)

    model_name = EMBEDDING_PRESETS[preset_name]
    host = host or _env("ROCKY_HOST", "127.0.0.1")
    port = port or int(_env("ROCKY_EMBED_PORT", "7778"))
    api_key = api_key or _env("ROCKY_API_KEY", "") or None

    import uvicorn
    from rocky.core import server as _server

    _server._api_key = api_key

    print(f"rocky embed → {preset_name} ({model_name}) {host}:{port}")

    _server.load_embedding_model(model_name, lock=True)

    uvicorn.run(_server.app, host=host, port=port, log_level="warning")
