from __future__ import annotations

import json
from pathlib import Path

import pytest

from rocky.search import to_search_json
from rocky.search.rocky_codebase import RockyCodebaseClient, RockyCodebaseConfig




def test_search_contract_merges_code_lines_into_context_block(tmp_path: Path) -> None:
    target = tmp_path / "rocky" / "search" / "contract.py"
    target.parent.mkdir(parents=True)
    target.write_text("\n".join(f"line {idx}" for idx in range(1, 90)) + "\n")

    payload = json.loads(
        to_search_json(
            "find evidence packaging",
            "<final_answer>\ncontract.py:20-20 - first\ncontract.py:35-35 - second\n</final_answer>",
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
            repo=tmp_path,
        )
    )

    assert payload["summary"] == "Found 1 evidence block(s)."
    assert payload["evidence"][0]["path"] == "settings.json"
    assert "rocky_search" in payload["evidence"][0]["snippet"]
    assert "rocky_context_build" in payload["evidence"][0]["snippet"]


class FakeIndexClient(RockyCodebaseClient):
    def __init__(self, config: RockyCodebaseConfig | None = None) -> None:
        super().__init__(config or RockyCodebaseConfig(enabled=True, auto_index=True))
        self.calls = 0
        self.paths: list[str] = []
        self.repo_token = "initial"

    def index_repository(self, repo_path: str | Path) -> dict:
        resolved = str(Path(repo_path).expanduser().resolve())
        self.calls += 1
        self.paths.append(resolved)
        return {"project": self.project_for_path(resolved), "status": "indexed"}

    def _repo_state_token(self, repo_path: str | Path) -> str | None:
        return self.repo_token


def test_codebase_index_status_indexed_is_ok_and_cached(tmp_path: Path) -> None:
    client = FakeIndexClient()

    first = client.ensure_indexed(tmp_path)
    second = client.ensure_indexed(tmp_path)

    assert first["ok"] is True
    assert first["status"] == "indexed"
    assert second == {"ok": True, "skipped": True, "reason": "fresh", "project": client.project_for_path(tmp_path)}
    assert client.calls == 1
    assert client.paths == [str(tmp_path.resolve())]


def test_codebase_index_reindexes_when_repo_state_changes(tmp_path: Path) -> None:
    client = FakeIndexClient()

    first = client.ensure_indexed(tmp_path)
    client.repo_token = "changed"
    second = client.ensure_indexed(tmp_path)

    assert first["ok"] is True
    assert second["ok"] is True
    assert second["status"] == "indexed"
    assert client.calls == 2


def test_codebase_default_index_uses_configured_project_path(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    client = FakeIndexClient(RockyCodebaseConfig(enabled=True, auto_index=True, project_path=str(repo)))

    result = client.ensure_default_indexed()

    assert result["ok"] is True
    assert client.paths == [str(repo.resolve())]


def test_codebase_scope_contract_resolves_workspace_and_parent_roots(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    child = workspace / "package"
    child.mkdir(parents=True)
    client = FakeIndexClient(RockyCodebaseConfig(enabled=True, auto_index=True, project_path=str(workspace)))

    workspace_scope = client.resolve_search_scope(path=workspace, cwd=child, scope="workspace")
    parent_scope = client.resolve_search_scope(path=workspace, cwd=child, scope="parent_1")

    assert workspace_scope["requested_scope"] == "workspace"
    assert workspace_scope["effective_roots"] == [str(workspace.resolve())]
    assert parent_scope["requested_scope"] == "parent_1"
    assert parent_scope["max_parent_depth"] == 1
    assert parent_scope["effective_roots"] == [str(workspace.resolve())]


def test_codebase_scope_contract_requires_explicit_roots(tmp_path: Path) -> None:
    client = FakeIndexClient()

    with pytest.raises(ValueError, match="explicit_roots requires at least one root"):
        client.resolve_search_scope(path=tmp_path, cwd=tmp_path, scope="explicit_roots", roots=[])


