from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rocky.serve import DEFAULT_PRESET, PRESETS


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    points: int
    detail: str


def main() -> int:
    preset = PRESETS.get(DEFAULT_PRESET)
    checks = [
        Check(
            "fastcontext preset removed",
            "fastcontext" not in PRESETS,
            20,
            "FastContext search/runtime preset is not registered",
        ),
        Check(
            "default preset exists",
            preset is not None,
            20,
            f"DEFAULT_PRESET={DEFAULT_PRESET!r} resolves to a registered runtime preset",
        ),
        Check(
            "default model id",
            bool(preset and preset.alias == "gemma-4-12b-qat-4bit"),
            20,
            "Gemma 4 12B is the zero-config LLM runtime target",
        ),
        Check(
            "no thinking default",
            bool(preset and preset.no_thinking is True),
            20,
            "Default runtime preset disables thinking for predictable lightweight serving",
        ),
        Check(
            "bounded token configuration",
            bool(preset and preset.prefill_step_size == 4096 and preset.max_tokens == 32768),
            20,
            "Default preset has deterministic bounded runtime defaults for stage validation",
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
