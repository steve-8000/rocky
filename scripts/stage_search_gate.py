from __future__ import annotations

import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rocky.search import RepositoryTools, RockySearchConfig, plan_scope, to_search_json


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

    read_output = RepositoryTools(root).read("contract.py")
    payload = json.loads(
        to_search_json(
            "find ROCKY_STAGE_MARKER packaging",
            "<final_answer>\ncontract.py:20-20 - code\ncontract.py:35-35 - code\nREADME.md:10-10 - docs\napp.log:90-90 - log\nservice.prom:50-50 - metric\n</final_answer>",
            turns=3,
            tool_messages=2,
            repo=root,
        )
    )
    plan = plan_scope(root, RockySearchConfig(max_files_per_unit=2, max_units=4))
    evidence = payload["evidence"]
    by_path = {item["path"]: item for item in evidence}
    code = by_path.get("rocky/search/contract.py", {})
    return [
        Check("unique suffix READ recovery", "rocky/search/contract.py lines" in read_output, 20, "contract.py resolves to rocky/search/contract.py"),
        Check("nearby code line merge", code.get("start_line") == 20 and code.get("end_line") == 35, 20, "nearby code targets merge into one block"),
        Check("caller-ready code context", code.get("context_start_line") == 8 and code.get("context_end_line") == 47, 15, "code block has deterministic context"),
        Check("document/log/metrics classification", {"document", "log", "metrics"} <= {item.get("kind") for item in evidence}, 25, "non-code text gets type-aware packaging"),
        Check("scope planner splits broad path", len(plan.units) >= 2 and plan.total_files >= 4, 20, "planner creates bounded scope units"),
    ]


if __name__ == "__main__":
    raise SystemExit(main())
