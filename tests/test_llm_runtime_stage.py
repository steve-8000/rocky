from __future__ import annotations

from rocky.serve import DEFAULT_PRESET, PRESETS


def test_fastcontext_preset_is_not_registered() -> None:
    assert "fastcontext" not in PRESETS


def test_default_runtime_preset_is_gemma4() -> None:
    preset = PRESETS[DEFAULT_PRESET]

    assert DEFAULT_PRESET == "gemma4-12b"
    assert preset.alias == "gemma-4-12b-qat-4bit"
    assert preset.prefill_step_size == 4096
    assert preset.max_tokens == 32768
    assert preset.no_thinking is True
    assert preset.mllm is False
