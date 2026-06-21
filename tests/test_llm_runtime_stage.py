from __future__ import annotations

from rocky.serve import DEFAULT_PRESET, PRESETS


def test_fastcontext_preset_exists_for_stage_one_llm_runtime() -> None:
    preset = PRESETS["fastcontext"]

    assert preset.alias == "microsoft/FastContext-1.0-4B-SFT"
    assert preset.tool_call_parser == "qwen"
    assert preset.prefill_step_size == 4096
    assert preset.max_tokens == 8192


def test_fastcontext_runtime_uses_single_model_without_embedding_preset() -> None:
    preset = PRESETS["fastcontext"]

    assert preset.embedding_model is None
    assert preset.mllm is False
    assert preset.no_thinking is False


def test_zero_config_serve_defaults_to_integrated_fastcontext_backend() -> None:
    assert DEFAULT_PRESET == "fastcontext"
