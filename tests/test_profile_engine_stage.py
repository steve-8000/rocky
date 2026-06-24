from __future__ import annotations

from pathlib import Path
import sys

from rocky.search.profile_engine import RockyProfileEngine
from rocky.search.profiles import ProfileBudget
from rocky.search.rocky_codebase import CodebaseCandidate, RockyCodebaseClient, RockyCodebaseConfig
from rocky.core.routes import rocky_native


def test_profile_plan_returns_bounded_read_points_with_hashes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "packages" / "coding-agent" / "src" / "rocky" / "backend.ts"
    source.parent.mkdir(parents=True)
    source.write_text(
        "\n".join(
            [
                "export class RockyClient {",
                "  async buildContext(query: string) {",
                "    return this.request('POST', '/v1/context/build', { query });",
                "  }",
                "}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    plan = engine.plan(
        {
            "profile": "find_definition",
            "query": "RockyClient buildContext context/build",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "budget": {
                "max_primary_points": 2,
                "max_primary_files": 1,
                "max_primary_lines": 12,
                "max_deferred_clusters": 2,
                "max_total_response_chars": 8000,
            },
        }
    )

    assert plan["ok"] is True
    assert plan["profile"] == "find_definition"
    assert plan["search_scope"]["effective_roots"] == [str(repo.resolve())]
    assert plan["budget_used"]["primary_points"] == 1
    assert plan["budget_used"]["primary_lines"] <= 12
    assert "candidates" not in plan
    assert plan["primary"][0]["file"] == "packages/coding-agent/src/rocky/backend.ts"
    assert plan["primary"][0]["file_revision"].startswith("sha256:")
    assert "buildContext" in plan["primary"][0]["snippet"]
    assert "\n" not in plan["primary"][0]["snippet"]
    assert "\\n" in plan["primary"][0]["snippet"]
    assert plan["primary"][0]["point_id"]
    assert plan["collector_stats"]["lexical"]["returned"] >= 1
    assert plan["collector_stats"]["ast"]["returned"] >= 1
    assert plan["collector_stats"]["lsp"]["available"] is False
    assert plan["collector_stats"]["lsp"]["skipped_reason"] == "not_configured"
    assert "raw" not in plan["collector_stats"]["lexical"]

    loaded = engine.get_plan(plan["plan_id"])
    assert loaded["plan_id"] == plan["plan_id"]
    assert loaded["collector_stats"] == plan["collector_stats"]


def test_profile_read_and_validate_detect_stale_points(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "settings.ts"
    source.parent.mkdir(parents=True)
    source.write_text("export const rocky = { apiUrl: 'http://127.0.0.1:7777' };\n", encoding="utf-8")
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )
    plan = engine.plan(
        {
            "profile": "config_lookup",
            "query": "rocky apiUrl",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
        }
    )
    point_id = plan["primary"][0]["point_id"]

    read = engine.read_points({"plan_id": plan["plan_id"], "point_ids": [point_id]})
    assert read["ok"] is True
    assert read["points"][0]["fresh"] is True
    assert "apiUrl" in read["points"][0]["snippet"]

    source.write_text("export const rocky = { apiUrl: 'http://localhost:7777' };\n", encoding="utf-8")
    validation = engine.validate_points({"plan_id": plan["plan_id"], "point_ids": [point_id]})

    assert validation["ok"] is True
    assert validation["points"][0]["fresh"] is False


def test_profile_expand_returns_bounded_secondary_points(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    for index in range(5):
        source = repo / "src" / "memory" / f"caller_{index}.ts"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(
            "\n".join(
                [
                    f"export function caller{index}() {{",
                    "  return rockyMemory.store('fact');",
                    "}",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    plan = engine.plan(
        {
            "profile": "memory_contract",
            "query": "rockyMemory store caller",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "budget": {
                "max_primary_points": 1,
                "max_primary_files": 1,
                "max_primary_lines": 6,
                "max_deferred_clusters": 3,
                "max_total_response_chars": 8000,
            },
        }
    )

    cluster_id = plan["deferred_clusters"][0]["cluster_id"]
    expanded = engine.expand(
        {
            "plan_id": plan["plan_id"],
            "cluster_id": cluster_id,
            "budget": {"max_primary_points": 2, "max_primary_lines": 12},
        }
    )

    assert expanded["ok"] is True
    assert expanded["cluster_id"] == cluster_id
    assert 1 <= len(expanded["points"]) <= 2
    assert all(point["file_revision"].startswith("sha256:") for point in expanded["points"])
    assert all("rockyMemory.store" in point["snippet"] for point in expanded["points"])
    assert "\n" not in expanded["points"][0]["snippet"]
    assert expanded["budget_used"]["primary_points"] == len(expanded["points"])
    assert "candidates" not in expanded


def test_profile_plan_fuses_graph_candidates_with_lexical_evidence(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "service.py"
    source.parent.mkdir(parents=True)
    source.write_text(
        "\n".join(
            [
                "class RockyMemoryService:",
                "    def store(self, text):",
                "        return text",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    class FakeGraphClient(RockyCodebaseClient):
        def __init__(self) -> None:
            super().__init__(RockyCodebaseConfig(enabled=True, auto_index=False))

        def available(self) -> bool:
            return True

        def search_graph(self, query: str, repo_path: str | Path, limit: int = 20):
            return [CodebaseCandidate("src/service.py", 1, end_line=3, label="RockyMemoryService")]

    engine = RockyProfileEngine(FakeGraphClient(), plan_root=tmp_path / ".rocky-plans")

    plan = engine.plan(
        {
            "profile": "find_definition",
            "query": "RockyMemoryService store",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
        }
    )

    first = plan["primary"][0]
    assert first["file"] == "src/service.py"
    assert "graph" in first["signals"]
    assert "lexical" in first["signals"]
    assert "graph" in first["reason"]


def test_profile_plan_fuses_ast_grep_structural_matches(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "routes.ts"
    source.parent.mkdir(parents=True)
    source.write_text('router.post("/v1/rocky/codebase/plan", handler);\n', encoding="utf-8")
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    plan = engine.plan(
        {
            "profile": "api_route_lookup",
            "query": "rocky codebase plan route",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
        }
    )

    first = plan["primary"][0]
    assert first["file"] == "src/routes.ts"
    assert "ast_grep" in first["signals"]
    assert "lexical" in first["signals"]
    assert "ast_grep" in first["reason"]
    assert "\\n" not in first["snippet"]


def test_profile_plan_fuses_ast_symbol_definitions(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "service.py"
    source.parent.mkdir(parents=True)
    source.write_text(
        "\n".join(
            [
                "class BillingService:",
                "    def charge_customer(self, account_id):",
                "        return account_id",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    plan = engine.plan(
        {
            "profile": "find_definition",
            "query": "BillingService charge_customer",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
        }
    )

    first = plan["primary"][0]
    assert first["file"] == "src/service.py"
    assert first["symbol"] in {"BillingService", "BillingService.charge_customer", "charge_customer"}
    assert "ast" in first["signals"]
    assert "lexical" in first["signals"]
    assert "ast" in first["reason"]


def test_profile_constraints_control_tests_changed_files_and_lexical_fallback(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "billing.ts"
    test_source = repo / "src" / "billing.test.ts"
    source.parent.mkdir(parents=True)
    source.write_text(
        "\n".join(
            [
                "export function chargeCustomer() {",
                "  return 'charged';",
                "}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    test_source.write_text(
        "\n".join(
            [
                "import { chargeCustomer } from './billing';",
                "test('chargeCustomer charges a customer', () => {",
                "  expect(chargeCustomer()).toBe('charged');",
                "});",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    no_tests = engine.plan(
        {
            "profile": "trace_impact",
            "query": "chargeCustomer",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "budget": {"max_primary_points": 4, "max_primary_files": 4, "max_primary_lines": 80},
            "constraints": {"include_tests": False},
        }
    )
    changed_preferred = engine.plan(
        {
            "profile": "trace_impact",
            "query": "chargeCustomer",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "budget": {"max_primary_points": 4, "max_primary_files": 4, "max_primary_lines": 80},
            "constraints": {"include_tests": True, "changed_files": ["src/billing.test.ts"]},
        }
    )
    no_lexical = engine.plan(
        {
            "profile": "trace_impact",
            "query": "only appears in prose",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "budget": {"max_primary_points": 4, "max_primary_files": 4, "max_primary_lines": 80},
            "constraints": {"allow_lexical_fallback": False},
        }
    )

    assert no_tests["constraints"]["include_tests"] is False
    assert all(".test." not in point["file"] for point in no_tests["primary"])
    assert changed_preferred["constraints"]["changed_files"] == ["src/billing.test.ts"]
    assert changed_preferred["primary"][0]["file"] == "src/billing.test.ts"
    assert "changed_file" in changed_preferred["primary"][0]["signals"]
    assert no_lexical["constraints"]["allow_lexical_fallback"] is False
    assert no_lexical["primary"] == []


def test_profile_lexical_collector_finds_late_files_in_large_repositories(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    bulk = repo / "src" / "bulk"
    bulk.mkdir(parents=True)
    for index in range(700):
        (bulk / f"module_{index:04d}.ts").write_text(
            f"export const unrelated{index} = 'ordinary module';\n",
            encoding="utf-8",
        )
    target = repo / "src" / "zzzz_target" / "payment.ts"
    target.parent.mkdir(parents=True)
    target.write_text(
        "\n".join(
            [
                "export const paymentGateway = {",
                "  retryKey: 'NeedlePaymentGateway',",
                "};",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    plan = engine.plan(
        {
            "profile": "bug_investigation",
            "query": "NeedlePaymentGateway retryKey",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "budget": {"max_primary_points": 2, "max_primary_files": 1, "max_primary_lines": 16},
        }
    )

    assert plan["primary"][0]["file"] == "src/zzzz_target/payment.ts"
    assert plan["budget_used"]["primary_points"] == 1
    assert "NeedlePaymentGateway" in plan["primary"][0]["snippet"]
    assert "candidates" not in plan


def test_profile_plan_returns_empty_reason_without_candidate_flood(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "service.ts"
    source.parent.mkdir(parents=True)
    source.write_text("export function ordinarySymbol() { return 1; }\n", encoding="utf-8")
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    plan = engine.plan(
        {
            "profile": "find_definition",
            "query": "MissingSymbol",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "constraints": {"allow_lexical_fallback": False},
            "budget": {"max_primary_points": 2, "max_primary_files": 1, "max_primary_lines": 20},
        }
    )

    assert plan["ok"] is True
    assert plan["primary"] == []
    assert plan["empty_reason"]["code"] == "no_evidence"
    assert "No Rocky codebase evidence matched" in plan["empty_reason"]["message"]
    assert plan["empty_reason"]["collector_stats"]["lexical"]["skipped_reason"] == "disabled_by_constraints"
    assert "candidates" not in plan
    assert "raw" not in plan["empty_reason"]


def test_profile_plan_collects_lsp_bridge_evidence(monkeypatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "service.ts"
    source.parent.mkdir(parents=True)
    source.write_text(
        "\n".join(
            [
                "export function targetSymbol() {",
                "  return 1;",
                "}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    bridge = tmp_path / "fake_lsp_bridge.py"
    bridge.write_text(
        "\n".join(
            [
                "import json, sys",
                "request = json.load(sys.stdin)",
                "root = request['search_scope']['effective_roots'][0]",
                "json.dump({'ok': True, 'evidence': [{",
                "  'root': root,",
                "  'file': 'src/service.ts',",
                "  'start_line': 1,",
                "  'end_line': 3,",
                "  'symbol': 'targetSymbol',",
                "  'relation': 'definition',",
                "  'score': 11,",
                "  'confidence': 0.96,",
                "  'matched_terms': ['targetSymbol']",
                "}]}, sys.stdout)",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ROCKY_LSP_COLLECTOR_COMMAND", f"{sys.executable} {bridge}")
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    health = engine.health()
    plan = engine.plan(
        {
            "profile": "find_definition",
            "query": "targetSymbol",
            "scope": {"kind": "workspace", "cwd": str(repo), "roots": [str(repo)]},
            "budget": {"max_primary_points": 2, "max_primary_files": 1, "max_primary_lines": 20},
        }
    )

    assert health["collectors"]["lsp"]["available"] is True
    assert plan["primary"][0]["file"] == "src/service.ts"
    assert "lsp" in plan["primary"][0]["signals"]
    assert plan["primary"][0]["symbol"] == "targetSymbol"
    assert "candidates" not in plan


def test_profile_catalog_and_health_are_bounded(tmp_path: Path) -> None:
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )

    profiles = engine.profiles()
    health = engine.health()

    assert "bug_investigation" in {profile["name"] for profile in profiles["profiles"]}
    assert all("default_budget" in profile for profile in profiles["profiles"])
    assert {profile["default_budget"]["max_total_response_chars"] for profile in profiles["profiles"]} == {10_000}
    assert ProfileBudget.from_raw({"max_total_response_chars": 200_000}, "bug_investigation").max_total_response_chars == 50_000
    assert health["ok"] is True
    assert health["collectors"]["lexical"]["available"] is True
    assert health["collectors"]["ast"]["available"] is True
    assert health["collectors"]["ast_grep"]["available"] is True
    assert "plans" in health


def test_profile_routes_plan_read_validate_and_delete(monkeypatch, tmp_path: Path) -> None:
    import asyncio

    repo = tmp_path / "repo"
    source = repo / "src" / "router.py"
    source.parent.mkdir(parents=True)
    source.write_text("router.post('/v1/rocky/codebase/plan')\n", encoding="utf-8")
    engine = RockyProfileEngine(
        RockyCodebaseClient(RockyCodebaseConfig(enabled=True, auto_index=False)),
        plan_root=tmp_path / ".rocky-plans",
    )
    monkeypatch.setattr(rocky_native, "_profile_engine", engine)

    plan = asyncio.run(
        rocky_native.codebase_profile_plan(
            rocky_native.CodebaseProfilePlanRequest(
                profile="api_route_lookup",
                query="rocky codebase plan route",
                scope=rocky_native.CodebaseProfileScope(kind="workspace", cwd=str(repo), roots=[str(repo)]),
            )
        )
    )
    point_id = plan["primary"][0]["point_id"]
    read = asyncio.run(
        rocky_native.codebase_profile_read(
            rocky_native.CodebaseProfileReadRequest(plan_id=plan["plan_id"], point_ids=[point_id])
        )
    )
    validation = asyncio.run(
        rocky_native.codebase_profile_validate(
            rocky_native.CodebaseProfileReadRequest(plan_id=plan["plan_id"], point_ids=[point_id])
        )
    )
    deleted = asyncio.run(rocky_native.codebase_profile_delete(plan["plan_id"]))

    assert plan["ok"] is True
    assert plan["search_scope"]["effective_roots"] == [str(repo.resolve())]
    assert read["points"][0]["fresh"] is True
    assert validation["points"][0]["fresh"] is True
    assert deleted == {"ok": True, "deleted": True}


def test_profile_route_schema_exposes_typed_constraints() -> None:
    schema = rocky_native.CodebaseProfilePlanRequest.model_json_schema()
    constraints_ref = schema["properties"]["constraints"]["anyOf"][0]["$ref"].rsplit("/", 1)[-1]
    constraints_schema = schema["$defs"][constraints_ref]

    assert set(constraints_schema["properties"]) == {
        "include_tests",
        "prefer_changed_files",
        "allow_lexical_fallback",
        "allow_llm_summary",
        "changed_files",
    }
    assert constraints_schema["additionalProperties"] is False
    request = rocky_native.CodebaseProfilePlanRequest(
        query="needle",
        constraints=rocky_native.CodebaseProfileConstraints(
            include_tests=False,
            prefer_changed_files=True,
            allow_lexical_fallback=False,
            changed_files=["src/service.ts"],
        ),
    )

    assert request.model_dump(exclude_none=True)["constraints"] == {
        "include_tests": False,
        "prefer_changed_files": True,
        "allow_lexical_fallback": False,
        "changed_files": ["src/service.ts"],
    }
