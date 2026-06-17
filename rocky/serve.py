from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field


@dataclass
class Preset:
    alias: str
    prefill_step_size: int = 4096
    max_tokens: int = 8192
    no_thinking: bool = False
    mllm: bool = False
    embedding_model: str | None = None
    extra_flags: list[str] = field(default_factory=list)


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
        embedding_model=EMBEDDING_MODEL_DEFAULT,
    ),
    "qwen3.6-27b": Preset(
        alias="qwen3.6-27b-4bit",
        prefill_step_size=4096,
        max_tokens=32768,
        embedding_model=EMBEDDING_MODEL_DEFAULT,
    ),
    "qwen3.6-35b": Preset(
        alias="qwen3.6-35b-4bit",
        prefill_step_size=8192,
        max_tokens=32768,
        embedding_model=EMBEDDING_MODEL_DEFAULT,
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
    embedding_model: str | None = None,
    extra: list[str] | None = None,
) -> None:
    preset_name = preset_name or _env("ROCKY_PRESET", DEFAULT_PRESET)
    if preset_name not in PRESETS:
        print(f"Unknown preset '{preset_name}'. Available: {', '.join(PRESETS)}", file=sys.stderr)
        sys.exit(1)

    preset = PRESETS[preset_name]
    host = host or _env("ROCKY_HOST", "127.0.0.1")
    port = port or int(_env("ROCKY_PORT", "7777"))
    api_key = api_key or _env("ROCKY_API_KEY", "") or None
    embedding_model = embedding_model or _env("ROCKY_EMBEDDING_MODEL", "") or preset.embedding_model or None

    import uvicorn
    from rocky.core import server as _server
    from rocky.core.middleware.auth import configure_rate_limiter
    from rocky.core.model_aliases import resolve_profile
    from rocky.core.scheduler import SchedulerConfig

    _server._no_thinking = preset.no_thinking
    _server._api_key = api_key
    _server._model_alias = preset.alias

    profile = resolve_profile(preset.alias)
    model_name = profile.hf_path if profile else preset.alias

    scheduler_config = SchedulerConfig(prefill_step_size=preset.prefill_step_size)

    print(f"rocky → {preset_name} ({preset.alias})")
    print(f"  host={host}:{port}  no_thinking={preset.no_thinking}  prefill_step={preset.prefill_step_size}")

    _server.load_model(
        model_name=model_name,
        scheduler_config=scheduler_config,
        max_tokens=preset.max_tokens,
        force_mllm=preset.mllm,
    )

    if embedding_model:
        _server.load_embedding_model(embedding_model, lock=True)

    uvicorn.run(_server.app, host=host, port=port, log_level="warning")
