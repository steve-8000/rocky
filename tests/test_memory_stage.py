from __future__ import annotations

import json
from pathlib import Path

from rocky.memory import MemoryEngine, MemoryScope


def test_memory_store_and_recall_project_scope(tmp_path: Path) -> None:
    engine = MemoryEngine(tmp_path / "memory")
    project = tmp_path / "project"
    project.mkdir()
    scope = MemoryScope("project", project_path=str(project))

    fact = engine.store("Rocky search engine packages evidence into context blocks.", scope, tags=("search",))
    hits = engine.recall("context block search evidence", scope)

    assert fact.id
    assert hits
    assert hits[0].fact.text == fact.text
    assert hits[0].score > 0
    assert (tmp_path / "memory" / "memory.jsonl").exists()
    assert (tmp_path / "memory" / "canonical.json").exists()


def test_memory_scope_isolation_and_visibility(tmp_path: Path) -> None:
    engine = MemoryEngine(tmp_path / "memory")
    project_a = tmp_path / "a"
    project_b = tmp_path / "b"
    project_a.mkdir()
    project_b.mkdir()

    engine.store("Global preference: answer in Korean.", MemoryScope("global"), tags=("preference",))
    engine.store("Project A uses FastContext for search.", MemoryScope("project", project_path=str(project_a)))
    engine.store("Project B uses a different runtime.", MemoryScope("project", project_path=str(project_b)))
    engine.store(
        "Path memory: logs use event windows.",
        MemoryScope("path", project_path=str(project_a), path=str(project_a / "logs")),
        tags=("logs",),
    )

    project_hits = engine.recall("FastContext Korean", MemoryScope("project", project_path=str(project_a)))
    path_hits = engine.recall("event windows logs", MemoryScope("path", project_path=str(project_a), path=str(project_a / "logs")))
    other_hits = engine.recall("FastContext", MemoryScope("project", project_path=str(project_b)))

    assert any("Korean" in hit.fact.text for hit in project_hits)
    assert any("FastContext" in hit.fact.text for hit in project_hits)
    assert any("event windows" in hit.fact.text for hit in path_hits)
    assert not any("Project A" in hit.fact.text for hit in other_hits)


def test_memory_delete_and_optimize(tmp_path: Path) -> None:
    engine = MemoryEngine(tmp_path / "memory")
    scope = MemoryScope("project", project_path=str(tmp_path / "project"))

    first = engine.store("Duplicate fact for optimization.", scope)
    second = engine.store("Another fact to delete.", scope)
    engine.store("Duplicate fact for optimization.", scope)

    assert first.id
    assert engine.delete(scope, id=second.id) == 1
    assert not engine.recall("Another delete", scope)

    result = engine.optimize()
    assert result["remaining"] == 1
    canonical = json.loads((tmp_path / "memory" / "canonical.json").read_text())
    assert len(canonical["facts"]) == 1
