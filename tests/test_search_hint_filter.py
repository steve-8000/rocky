from __future__ import annotations

import json
from pathlib import Path

from rocky.search.contract import to_search_json


def test_search_contract_prefers_query_hint_files_over_noisy_changelog(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        '{\n  "name": "demo",\n  "scripts": {"release": "node scripts/release.mjs"}\n}\n',
        encoding="utf-8",
    )
    noisy = tmp_path / "packages" / "coding-agent" / "CHANGELOG.md"
    noisy.parent.mkdir(parents=True)
    noisy.write_text(
        "\n".join(
            [
                "release flow workspace package scripts",
                "release flow workspace package scripts",
                "release flow workspace package scripts",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    payload = json.loads(
        to_search_json(
            "Only search these likely integration files: package.json. Need release flow workspace package scripts.",
            "",
            turns=1,
            tool_messages=1,
            repo=tmp_path,
        )
    )

    assert payload["summary"] == "Found 1 evidence block(s)."
    assert payload["evidence"][0]["path"] == "package.json"
    assert "scripts" in payload["evidence"][0]["snippet"]
