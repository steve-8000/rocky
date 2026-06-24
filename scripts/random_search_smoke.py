from __future__ import annotations

import argparse
import json
import random
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


DEFAULT_REPOS = (
    Path("/Users/steve/amaze_s3/rocky/rocky"),
    Path("/Users/steve/amaze_s3/amaze"),
)

SKIP_PARTS = {
    ".amaze-work",
    ".git",
    ".harness",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
    "target",
    "vendor",
}



@dataclass(frozen=True)
class SearchCase:
    index: int
    repo: str
    path: str
    query: str
    target: str


@dataclass(frozen=True)
class SearchResult:
    index: int
    repo: str
    target: str
    query: str
    ok: bool
    index_ok: bool
    fallback: bool
    has_evidence: bool
    evidence_count: int
    elapsed_seconds: float
    error: str | None = None

    @property
    def passed(self) -> bool:
        return self.ok and self.index_ok and not self.fallback and self.has_evidence


def main() -> int:
    args = parse_args()
    repos = [Path(raw).expanduser().resolve() for raw in args.repo]
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    run_id = args.run_id or time.strftime("%Y%m%d-%H%M%S")
    jsonl_path = output_dir / f"rocky-search-random-{run_id}.jsonl"
    summary_path = output_dir / f"rocky-search-random-{run_id}.summary.json"

    rng = random.Random(args.seed)
    cases = build_cases(repos, args.count, rng)
    results: list[SearchResult] = []

    with jsonl_path.open("w", encoding="utf-8") as stream:
        for case in cases:
            result = run_case(args.endpoint, case, timeout=args.timeout)
            results.append(result)
            stream.write(json.dumps({**asdict(result), "passed": result.passed}, ensure_ascii=False) + "\n")
            stream.flush()
            if result.index % args.checkpoint == 0:
                print(json.dumps({"checkpoint": result.index, **summarize(results)}, ensure_ascii=False), flush=True)

    summary = {
        "run_id": run_id,
        "endpoint": args.endpoint,
        "seed": args.seed,
        "count": args.count,
        "checkpoint": args.checkpoint,
        "jsonl": str(jsonl_path),
        **summarize(results),
        "failures": [asdict(result) | {"passed": result.passed} for result in results if not result.passed],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"summary": str(summary_path), **summary}, ensure_ascii=False, indent=2))
    return 0 if summary["score"] >= args.min_score else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run randomized Rocky /v1/search validation.")
    parser.add_argument("--endpoint", default="http://127.0.0.1:7777/v1/search")
    parser.add_argument("--repo", action="append", default=[repo.as_posix() for repo in DEFAULT_REPOS])
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--checkpoint", type=int, default=10)
    parser.add_argument("--seed", type=int, default=6212026)
    parser.add_argument("--timeout", type=float, default=420.0)
    parser.add_argument("--min-score", type=float, default=90.0)
    parser.add_argument("--output-dir", default=".rocky/runs")
    parser.add_argument("--run-id", default="")
    return parser.parse_args()


def build_cases(repos: list[Path], count: int, rng: random.Random) -> list[SearchCase]:
    pools = [(repo, discover_targets(repo)) for repo in repos]
    pools = [(repo, targets) for repo, targets in pools if targets]
    if not pools:
        raise SystemExit("No target files discovered.")

    cases: list[SearchCase] = []
    templates = (
        "Find the implementation related to {stem} in {target}.",
        "Find code evidence for file {target} and its main role.",
        "Where is {stem} defined or wired in this repository?",
        "Find search-relevant evidence around {target}.",
        "Locate the route, tool, or helper connected to {stem}.",
        "Find the tests or implementation that mention {stem}.",
    )
    for index in range(1, count + 1):
        repo, targets = rng.choice(pools)
        target = rng.choice(targets)
        stem = target.stem.replace("_", " ").replace("-", " ")
        query = rng.choice(templates).format(stem=stem, target=target.as_posix())
        cases.append(
            SearchCase(
                index=index,
                repo=repo.name,
                path=repo.as_posix(),
                query=query,
                target=target.as_posix(),
            )
        )
    return cases


def discover_targets(repo: Path) -> list[Path]:
    targets: list[Path] = []
    for path in repo.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(repo)
        except ValueError:
            continue
        if any(part in SKIP_PARTS for part in rel.parts):
            continue
        if path.suffix.lower() not in {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".toml", ".yml", ".yaml"}:
            continue
        targets.append(rel)
    return sorted(targets)


def run_case(endpoint: str, case: SearchCase, *, timeout: float) -> SearchResult:
    start = time.monotonic()
    try:
        payload = request_json(endpoint, {"query": case.query, "path": case.path}, timeout=timeout)
        elapsed = time.monotonic() - start
        runtime = payload.get("runtime") if isinstance(payload, dict) else {}
        runtime = runtime if isinstance(runtime, dict) else {}
        index_entries = runtime.get("codebase_index") if isinstance(runtime.get("codebase_index"), list) else []
        evidence = payload.get("evidence") if isinstance(payload.get("evidence"), list) else []
        return SearchResult(
            index=case.index,
            repo=case.repo,
            target=case.target,
            query=case.query,
            ok=payload.get("status") == "ok",
            index_ok=any(isinstance(item, dict) and item.get("ok") for item in index_entries),
            fallback=bool(runtime.get("codebase_fallback_used")),
            has_evidence=bool(evidence),
            evidence_count=len(evidence),
            elapsed_seconds=round(elapsed, 3),
        )
    except Exception as exc:
        return SearchResult(
            index=case.index,
            repo=case.repo,
            target=case.target,
            query=case.query,
            ok=False,
            index_ok=False,
            fallback=True,
            has_evidence=False,
            evidence_count=0,
            elapsed_seconds=round(time.monotonic() - start, 3),
            error=str(exc),
        )


def request_json(endpoint: str, body: dict[str, Any], *, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail[:500]}") from exc


def summarize(results: list[SearchResult]) -> dict[str, Any]:
    total = len(results)
    passed = sum(1 for result in results if result.passed)
    summary = {
        "total": total,
        "passed": passed,
        "score": round((passed / total * 100) if total else 0.0, 2),
        "ok": sum(result.ok for result in results),
        "index_ok": sum(result.index_ok for result in results),
        "fallback": sum(result.fallback for result in results),
        "with_evidence": sum(result.has_evidence for result in results),
        "max_elapsed_seconds": max((result.elapsed_seconds for result in results), default=0),
    }
    return summary


if __name__ == "__main__":
    raise SystemExit(main())
