from __future__ import annotations

from pathlib import Path

import pytest

from rocky.search.rocky_codebase import CodebaseCandidate
from rocky.skills.service import SKILL_TOOLS, SkillsService


class FakeCodebaseClient:
    def __init__(self, mode: str = "candidate") -> None:
        self.mode = mode
        self.indexed: list[Path] = []

    def index_repository(self, repo_path: str | Path) -> dict:
        self.indexed.append(Path(repo_path))
        return {"ok": True}

    def search_graph(self, query: str, repo_path: str | Path, limit: int = 20) -> list[CodebaseCandidate]:
        if self.mode == "raise":
            raise RuntimeError("search unavailable")
        if self.mode == "empty":
            return []
        return [CodebaseCandidate(str(Path(repo_path) / "alpha-skill.md"), 1, rank=0.75)]


def test_skill_tools_exports_expected_names() -> None:
    assert [tool["name"] for tool in SKILL_TOOLS] == [
        "skill_search",
        "skill_get",
        "skill_upsert",
        "skill_delete",
        "skill_list",
    ]


def test_upsert_get_list_delete_and_versioning(tmp_path: Path) -> None:
    client = FakeCodebaseClient()
    service = SkillsService(client, skills_dir=tmp_path)

    created = service.upsert(
        "alpha-skill",
        "Reusable alpha workflow",
        "# Body\nUse it carefully.\n",
        tags=["alpha", "workflow"],
    )

    assert created == {"name": "alpha-skill", "version": 1, "created": True}
    assert client.indexed == [tmp_path]
    assert (tmp_path / "manifest.json").is_file()

    loaded = service.get("alpha-skill")
    assert loaded == {
        "name": "alpha-skill",
        "summary": "Reusable alpha workflow",
        "tags": ["alpha", "workflow"],
        "body": "# Body\nUse it carefully.\n",
        "version": 1,
    }

    updated = service.upsert(
        "alpha-skill",
        "Reusable alpha workflow",
        "# Body\nUpdated.\n",
        tags=["alpha", "workflow"],
    )
    assert updated == {"name": "alpha-skill", "version": 2, "created": False}
    assert client.indexed == [tmp_path, tmp_path]

    assert service.list() == [
        {
            "name": "alpha-skill",
            "summary": "Reusable alpha workflow",
            "tags": ["alpha", "workflow"],
            "version": 2,
        }
    ]

    deleted = service.delete("alpha-skill")
    assert deleted == {"name": "alpha-skill", "deleted": True}
    assert service.list() == []
    with pytest.raises(KeyError):
        service.get("alpha-skill")


def test_search_uses_codebase_candidates_and_manifest_summary(tmp_path: Path) -> None:
    service = SkillsService(FakeCodebaseClient(), skills_dir=tmp_path)
    service.upsert(
        "alpha-skill",
        "Reusable alpha workflow",
        "# Body\nUse it carefully.\n",
        tags=["alpha"],
    )

    results = service.search("alpha workflow", limit=5)

    assert results == [
        {
            "name": "alpha-skill",
            "summary": "Reusable alpha workflow",
            "tags": ["alpha"],
            "version": 1,
            "score": 0.75,
        }
    ]


@pytest.mark.parametrize("mode", ["empty", "raise"])
def test_search_falls_back_to_manifest_matching(tmp_path: Path, mode: str) -> None:
    service = SkillsService(FakeCodebaseClient(mode=mode), skills_dir=tmp_path)
    service.upsert(
        "alpha-skill",
        "Reusable alpha workflow",
        "# Body\nUse it carefully.\n",
        tags=["alpha"],
    )

    results = service.search("workflow", limit=5)

    assert results == [
        {
            "name": "alpha-skill",
            "summary": "Reusable alpha workflow",
            "tags": ["alpha"],
            "version": 1,
            "score": 14.0,
        }
    ]


@pytest.mark.parametrize("name", ["../x", "a/b", ""])
def test_invalid_skill_names_raise_value_error(tmp_path: Path, name: str) -> None:
    service = SkillsService(FakeCodebaseClient(), skills_dir=tmp_path)

    with pytest.raises(ValueError):
        service.upsert(name, "summary", "body")
