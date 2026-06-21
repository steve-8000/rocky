from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rocky.serve import PRESETS


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    points: int
    detail: str


def main() -> int:
    preset = PRESETS.get("fastcontext")
    checks = [
        Check(
            "fastcontext preset exists",
            preset is not None,
            20,
            "PRESETS['fastcontext'] is available for Rocky LLM runtime stage",
        ),
        Check(
            "fastcontext model id",
            bool(preset and preset.alias == "microsoft/FastContext-1.0-4B-SFT"),
            20,
            "FastContext model is the stage-one LLM runtime target",
        ),
        Check(
            "qwen tool parser enabled",
            bool(preset and preset.tool_call_parser == "qwen"),
            25,
            "FastContext tool-call generation is wired to Qwen parser",
        ),
        Check(
            "single LLM runtime without embedding model",
            bool(preset and preset.embedding_model is None),
            20,
            "Memory/search should share the FastContext LLM instead of a separate embedding model",
        ),
        Check(
            "bounded token configuration",
            bool(preset and preset.prefill_step_size == 4096 and preset.max_tokens == 8192),
            15,
            "Preset has deterministic bounded runtime defaults for stage validation",
        ),
    ]
    score = sum(check.points for check in checks if check.passed)
    report = {
        "stage": "llm_runtime",
        "score": score,
        "passed": score >= 95,
        "threshold": 95,
        "checks": [check.__dict__ for check in checks],
    }
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
