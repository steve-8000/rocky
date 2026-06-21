from __future__ import annotations

import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rocky.memory import MemoryEngine, MemoryScope


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    points: int
    detail: str


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="rocky-memory-stage-") as raw:
        root = Path(raw)
        checks = _run_checks(root)
    score = sum(check.points for check in checks if check.passed)
    report = {
        "stage": "xenonite_compatible_memory",
        "score": score,
        "passed": score >= 95,
        "threshold": 95,
        "checks": [check.__dict__ for check in checks],
    }
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


def _run_checks(root: Path) -> list[Check]:
    engine = MemoryEngine(root / "memory")
    project = root / "project"
    other_project = root / "other"
    logs = project / "logs"
    logs.mkdir(parents=True)
    other_project.mkdir()
    project_scope = MemoryScope("project", project_path=str(project))
    path_scope = MemoryScope("path", project_path=str(project), path=str(logs))
    other_scope = MemoryScope("project", project_path=str(other_project))

    engine.store("Global preference: answer Steve in Korean.", MemoryScope("global"), tags=("preference",))
    project_fact = engine.store("Project decision: Rocky search uses FastContext context blocks.", project_scope, tags=("search",))
    path_fact = engine.store("Log files should be summarized by event windows.", path_scope, tags=("logs",))
    delete_fact = engine.store("Temporary memory to delete.", project_scope)
    duplicate = engine.store("Project decision: Rocky search uses FastContext context blocks.", project_scope, tags=("duplicate",))

    project_hits = engine.recall("FastContext context blocks Korean", project_scope)
    path_hits = engine.recall("logs event windows", path_scope)
    other_hits = engine.recall("FastContext context blocks", other_scope)
    deleted = engine.delete(project_scope, id=delete_fact.id)
    optimized = engine.optimize()

    return [
        Check("durable store files", (root / "memory" / "memory.jsonl").exists() and (root / "memory" / "canonical.json").exists(), 15, "memory.jsonl and canonical.json are written"),
        Check("project recall", any(hit.fact.id == project_fact.id for hit in project_hits), 20, "project fact recalls by lexical query"),
        Check("global visibility", any("Korean" in hit.fact.text for hit in project_hits), 15, "global facts are visible in project recall"),
        Check("path recall", any(hit.fact.id == path_fact.id for hit in path_hits), 20, "path facts recall only for matching path scope"),
        Check("scope isolation", not any("Rocky search uses FastContext" in hit.fact.text for hit in other_hits), 15, "other project cannot recall project-specific fact"),
        Check("delete support", deleted == 1 and not engine.recall("Temporary delete", project_scope), 10, "delete removes scoped memory"),
        Check("dedupe/update support", duplicate.id == project_fact.id and optimized["remaining"] >= 3, 5, "duplicate store updates canonical fact"),
    ]


if __name__ == "__main__":
    raise SystemExit(main())
