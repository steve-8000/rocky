from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


STAGES = (
    ("llm_runtime", "stage_llm_gate.py"),
    ("search_engine", "stage_search_gate.py"),
)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    reports = []
    for expected_stage, script_name in STAGES:
        proc = subprocess.run(
            [sys.executable, str(root / "scripts" / script_name)],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            print(proc.stdout, end="")
            print(proc.stderr, end="", file=sys.stderr)
            return proc.returncode
        report = json.loads(proc.stdout)
        if report["stage"] != expected_stage:
            raise RuntimeError(f"stage mismatch for {script_name}: {report['stage']} != {expected_stage}")
        reports.append(report)
    final_score = round(sum(report["score"] for report in reports) / len(reports), 2)
    output = {
        "goal": "rocky_single_repo_llm_search_memory_integration",
        "score": final_score,
        "passed": final_score >= 92 and all(report["score"] >= 95 and report["passed"] for report in reports),
        "threshold": 92,
        "stage_threshold": 95,
        "stages": reports,
    }
    print(json.dumps(output, indent=2))
    return 0 if output["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
