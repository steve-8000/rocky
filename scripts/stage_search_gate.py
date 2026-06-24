from __future__ import annotations

import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rocky.search import to_search_json


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    points: int
    detail: str


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="rocky-search-stage-") as raw:
        root = Path(raw)
        checks = _run_checks(root)
    score = sum(check.points for check in checks if check.passed)
    report = {
        "stage": "search_engine",
        "score": score,
        "passed": score >= 95,
        "threshold": 95,
        "checks": [check.__dict__ for check in checks],
    }
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


def _run_checks(root: Path) -> list[Check]:
    package = root / "rocky" / "search"
    package.mkdir(parents=True)
    (package / "contract.py").write_text("\n".join(f"line {idx}" for idx in range(1, 90)) + "\n")
    (root / "README.md").write_text("# Intro\nskip\n## Ops\n" + "\n".join(f"doc {idx}" for idx in range(1, 20)) + "\n## Other\n")
    (root / "app.log").write_text("\n".join(f"ERROR event {idx}" for idx in range(1, 151)) + "\n")
    (root / "service.prom").write_text("\n".join(f"metric_p99 {idx}" for idx in range(1, 101)) + "\n")

    payload = json.loads(
        to_search_json(
            "find ROCKY_STAGE_MARKER packaging",
            "<final_answer>\ncontract.py:20-20 - code\ncontract.py:35-35 - code\nREADME.md:10-10 - docs\napp.log:90-90 - log\nservice.prom:50-50 - metric\n</final_answer>",
            repo=root,
        )
    )
    evidence = payload["evidence"]
    by_path = {item["path"]: item for item in evidence}
    code = by_path.get("rocky/search/contract.py", {})
    return [
        Check("nearby code line merge", code.get("start_line") == 20 and code.get("end_line") == 35, 30, "nearby code targets merge into one block"),
        Check("caller-ready code context", code.get("context_start_line") == 8 and code.get("context_end_line") == 47, 25, "code block has deterministic context"),
        Check("document/log/metrics classification", {"document", "log", "metrics"} <= {item.get("kind") for item in evidence}, 45, "non-code text gets type-aware packaging"),
    ]


if __name__ == "__main__":
    raise SystemExit(main())
