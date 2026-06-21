from __future__ import annotations

import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rocky.integration import build_integrated_search_result
from rocky.memory import MemoryEngine, MemoryScope


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    points: int
    detail: str


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="rocky-integration-stage-") as raw:
        checks = _run_checks(Path(raw))
    score = sum(check.points for check in checks if check.passed)
    report = {
        "stage": "integrated_runtime_search_memory",
        "score": score,
        "passed": score >= 95,
        "threshold": 95,
        "checks": [check.__dict__ for check in checks],
    }
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


def _run_checks(root: Path) -> list[Check]:
    project = root / "project"
    target = project / "rocky" / "search" / "contract.py"
    target.parent.mkdir(parents=True)
    target.write_text("\n".join(f"line {idx}" for idx in range(1, 90)) + "\n")
    memory = MemoryEngine(root / "memory")
    scope = MemoryScope("project", project_path=str(project))
    fact = memory.store("Project decision: search evidence uses context blocks.", scope, tags=("search",))
    result = build_integrated_search_result(
        query="search evidence context blocks",
        path=project,
        final_answer="<final_answer>\ncontract.py:20-20 - target\ncontract.py:35-35 - nearby target\n</final_answer>",
        memory_engine=memory,
        memory_scope=scope,
        turns=3,
        tool_messages=2,
    )
    payload = result.search_payload
    evidence = payload["evidence"][0] if payload["evidence"] else {}
    return [
        Check("FastContext runtime linked", result.llm_model == "microsoft/FastContext-1.0-4B-SFT" and result.tool_call_parser == "qwen", 25, "integration uses stage-one LLM runtime preset"),
        Check("no embedding model", payload["runtime"]["embedding_model"] is None, 15, "memory/search share FastContext runtime without embedding model"),
        Check("memory recall attached", payload["memory"]["items"] and payload["memory"]["items"][0]["id"] == fact.id, 20, "project memory is recalled and attached"),
        Check("search evidence packaged", evidence.get("path") == "rocky/search/contract.py" and evidence.get("start_line") == 20 and evidence.get("end_line") == 35, 25, "search evidence is merged and packaged"),
        Check("caller-ready context", evidence.get("context_start_line") == 8 and evidence.get("context_end_line") == 47, 15, "integrated output has deterministic context block"),
    ]


if __name__ == "__main__":
    raise SystemExit(main())
