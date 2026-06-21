from __future__ import annotations

from pathlib import Path

from rocky.integration import build_integrated_search_result
from rocky.memory import MemoryEngine, MemoryScope


def test_integration_combines_fastcontext_memory_and_search(tmp_path: Path) -> None:
    project = tmp_path / "project"
    code_dir = project / "rocky" / "search"
    code_dir.mkdir(parents=True)
    (code_dir / "contract.py").write_text("\n".join(f"line {idx}" for idx in range(1, 80)) + "\n")
    memory = MemoryEngine(tmp_path / "memory")
    scope = MemoryScope("project", project_path=str(project))
    fact = memory.store("Project decision: search evidence is packaged into context blocks.", scope, tags=("search",))

    result = build_integrated_search_result(
        query="Where is search evidence packaged into context blocks?",
        path=project,
        final_answer="<final_answer>\ncontract.py:20-20 - evidence packaging target\n</final_answer>",
        memory_engine=memory,
        memory_scope=scope,
        turns=2,
        tool_messages=1,
    )

    payload = result.search_payload
    assert result.llm_model == "microsoft/FastContext-1.0-4B-SFT"
    assert result.tool_call_parser == "qwen"
    assert payload["runtime"]["embedding_model"] is None
    assert payload["memory"]["items"][0]["id"] == fact.id
    assert payload["evidence"][0]["path"] == "rocky/search/contract.py"
    assert payload["evidence"][0]["context_start_line"] == 8
    assert payload["evidence"][0]["context_end_line"] == 32
