from __future__ import annotations

import json
from pathlib import Path

import pytest

from rocky.search import RepositoryTools, RockySearchConfig, ToolError, plan_scope, to_search_json
from rocky.search.codebase_memory import CodebaseMemoryClient, CodebaseMemoryConfig


def test_search_tools_recover_unique_suffix_path(tmp_path: Path) -> None:
    package = tmp_path / "rocky" / "search"
    package.mkdir(parents=True)
    (package / "contract.py").write_text("def to_search_json():\n    return '{}'\n")

    output = RepositoryTools(tmp_path).read("contract.py")

    assert "rocky/search/contract.py lines 1-2" in output
    assert "1: def to_search_json():" in output


def test_search_tools_reject_ambiguous_suffix_path(tmp_path: Path) -> None:
    for dirname in ("a", "b"):
        directory = tmp_path / dirname
        directory.mkdir()
        (directory / "contract.py").write_text("ambiguous\n")

    with pytest.raises(ToolError, match="ambiguous"):
        RepositoryTools(tmp_path).read("contract.py")


def test_search_contract_merges_code_lines_into_context_block(tmp_path: Path) -> None:
    target = tmp_path / "rocky" / "search" / "contract.py"
    target.parent.mkdir(parents=True)
    target.write_text("\n".join(f"line {idx}" for idx in range(1, 90)) + "\n")

    payload = json.loads(
        to_search_json(
            "find evidence packaging",
            "<final_answer>\ncontract.py:20-20 - first\ncontract.py:35-35 - second\n</final_answer>",
            turns=2,
            tool_messages=1,
            repo=tmp_path,
        )
    )

    evidence = payload["evidence"][0]
    assert evidence["path"] == "rocky/search/contract.py"
    assert evidence["kind"] == "code"
    assert evidence["start_line"] == 20
    assert evidence["end_line"] == 35
    assert evidence["context_start_line"] == 8
    assert evidence["context_end_line"] == 47
    assert "20: line 20" in evidence["snippet"]
    assert "35: line 35" in evidence["snippet"]


def test_search_contract_packages_docs_logs_metrics_by_type(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("# Intro\nskip\n## Ops\n" + "\n".join(f"doc {idx}" for idx in range(1, 20)) + "\n## Other\n")
    (tmp_path / "app.log").write_text("\n".join(f"ERROR event {idx}" for idx in range(1, 151)) + "\n")
    (tmp_path / "service.prom").write_text("\n".join(f"metric_p99{{route='/{idx}'}} {idx}" for idx in range(1, 101)) + "\n")

    payload = json.loads(
        to_search_json(
            "find ops error metric",
            "<final_answer>\nREADME.md:10-10 - docs\napp.log:90-90 - log\nservice.prom:50-50 - metric\n</final_answer>",
            turns=3,
            tool_messages=2,
            repo=tmp_path,
        )
    )
    by_path = {item["path"]: item for item in payload["evidence"]}

    assert by_path["README.md"]["kind"] == "document"
    assert by_path["README.md"]["context_start_line"] == 3
    assert by_path["app.log"]["kind"] == "log"
    assert by_path["app.log"]["context_start_line"] == 30
    assert by_path["service.prom"]["kind"] == "metrics"
    assert by_path["service.prom"]["context_start_line"] == 30
    assert by_path["service.prom"]["context_end_line"] == 70


def test_search_contract_normalizes_host_prefixed_repo_and_answer_paths(tmp_path: Path) -> None:
    target = tmp_path / "README.md"
    target.write_text("# Intro\nline 2\nline 3\n", encoding="utf-8")

    host_repo = Path(f"/host{tmp_path.as_posix()}")
    host_target = f"/host{target.as_posix()}"

    payload = json.loads(
        to_search_json(
            "find readme evidence",
            f"<final_answer>\nREADME.md:1-2 - relative\n{host_target}:1-2 - absolute\n</final_answer>",
            turns=1,
            tool_messages=1,
            repo=host_repo,
        )
    )

    assert payload["summary"] == "Found 1 evidence block(s)."
    assert payload["evidence"][0]["path"] == "README.md"
    assert "1: # Intro" in payload["evidence"][0]["snippet"]
    assert "2: line 2" in payload["evidence"][0]["snippet"]


def test_search_contract_falls_back_to_lexical_search_without_answer_refs(tmp_path: Path) -> None:
    target = tmp_path / "settings.json"
    target.write_text(
        '{\n'
        '  "agentOverrides": {\n'
        '    "worker": {\n'
        '      "tools": ["rocky_search", "rocky_context_build", "mem_recall"]\n'
        "    }\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )
    noisy = tmp_path / "sessions" / "run.json"
    noisy.parent.mkdir()
    noisy.write_text(
        '{"task": "settings.json agentOverrides rocky_search rocky_context_build"}\n',
        encoding="utf-8",
    )

    payload = json.loads(
        to_search_json(
            "settings.json agentOverrides rocky_search rocky_context_build",
            "",
            turns=1,
            tool_messages=1,
            repo=tmp_path,
        )
    )

    assert payload["summary"] == "Found 1 evidence block(s)."
    assert payload["evidence"][0]["path"] == "settings.json"
    assert "rocky_search" in payload["evidence"][0]["snippet"]
    assert "rocky_context_build" in payload["evidence"][0]["snippet"]


class FakeIndexClient(CodebaseMemoryClient):
    def __init__(self) -> None:
        super().__init__(CodebaseMemoryConfig(enabled=True, auto_index=True))
        self.calls = 0

    def index_repository(self, repo_path: str | Path) -> dict:
        self.calls += 1
        return {"project": self.project_for_path(repo_path), "status": "indexed"}


def test_codebase_index_status_indexed_is_ok_and_cached(tmp_path: Path) -> None:
    client = FakeIndexClient()

    first = client.ensure_indexed(tmp_path)
    second = client.ensure_indexed(tmp_path)

    assert first["ok"] is True
    assert first["status"] == "indexed"
    assert second == {"ok": True, "skipped": True, "reason": "fresh", "project": client.project_for_path(tmp_path)}
    assert client.calls == 1


def test_search_planner_splits_broad_local_path(tmp_path: Path) -> None:
    for dirname in ("rocky", "tests"):
        (tmp_path / dirname).mkdir()
        for index in range(3):
            (tmp_path / dirname / f"file_{index}.py").write_text("content\n")

    plan = plan_scope(tmp_path, RockySearchConfig(max_files_per_unit=2, max_units=4))

    assert plan.total_files == 6
    assert [unit.path for unit in plan.units] == ["rocky", "tests"]
    assert "rocky/" in plan.manifest
