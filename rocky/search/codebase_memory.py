from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class CodebaseMemoryConfig:
    enabled: bool = True
    auto_index: bool = True
    endpoint: str | None = None
    binary: str = str(Path.home() / ".local" / "bin" / "codebase-memory-mcp")
    project: str | None = None
    timeout_seconds: float = 30.0
    stale_after_seconds: float = 300.0

    @classmethod
    def from_env(cls) -> "CodebaseMemoryConfig":
        return cls(
            enabled=_env_bool("ROCKY_CBM_ENABLED", True),
            auto_index=_env_bool("ROCKY_CBM_AUTO_INDEX", True),
            endpoint=os.getenv("ROCKY_CBM_ENDPOINT") or None,
            binary=os.getenv("ROCKY_CBM_BINARY", cls.binary),
            project=os.getenv("ROCKY_CBM_PROJECT") or None,
            timeout_seconds=float(os.getenv("ROCKY_CBM_TIMEOUT_SECONDS", "30")),
            stale_after_seconds=float(os.getenv("ROCKY_CBM_STALE_AFTER_SECONDS", "300")),
        )


@dataclass(frozen=True)
class CodebaseCandidate:
    file_path: str
    start_line: int
    end_line: int | None = None
    label: str | None = None
    name: str | None = None
    rank: float | None = None
    source: str = "codebase-memory"

    def target(self) -> str:
        return f"{self.file_path}:{max(self.start_line, 1)}"


class CodebaseMemoryClient:
    def __init__(self, config: CodebaseMemoryConfig | None = None) -> None:
        self.config = config or CodebaseMemoryConfig.from_env()
        self._indexed_at: dict[str, float] = {}

    def available(self) -> bool:
        if not self.config.enabled:
            return False
        if self.config.endpoint:
            return True
        return self._binary_path() is not None

    def project_for_path(self, repo_path: str | Path) -> str:
        if self.config.project:
            return self.config.project
        resolved = Path(repo_path).expanduser().resolve()
        return str(resolved).strip("/").replace("/", "-")

    def ensure_indexed(self, repo_path: str | Path) -> dict[str, Any]:
        if not self.config.enabled or not self.config.auto_index:
            return {"ok": False, "skipped": True, "reason": "disabled"}
        repo = str(Path(repo_path).expanduser().resolve())
        now = time.time()
        last = self._indexed_at.get(repo)
        if last is not None and now - last < self.config.stale_after_seconds:
            return {"ok": True, "skipped": True, "reason": "fresh", "project": self.project_for_path(repo)}
        result = _normalize_index_result(self.index_repository(repo))
        if result.get("ok"):
            self._indexed_at[repo] = now
        return result

    def index_repository(self, repo_path: str | Path) -> dict[str, Any]:
        return self._call("index_repository", {"repo_path": str(Path(repo_path).expanduser().resolve())})

    def search_graph(self, query: str, repo_path: str | Path, limit: int = 20) -> list[CodebaseCandidate]:
        project = self.project_for_path(repo_path)
        payload = {"project": project, "query": query, "limit": limit}
        return self._candidates(self._call("search_graph", payload))

    def search_code(self, pattern: str, repo_path: str | Path, limit: int = 20) -> list[CodebaseCandidate]:
        project = self.project_for_path(repo_path)
        payload = {"project": project, "pattern": pattern, "limit": limit}
        return self._candidates(self._call("search_code", payload))

    def _call(self, tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.config.enabled:
            raise RuntimeError("codebase-memory is disabled")
        if self.config.endpoint:
            return self._call_endpoint(tool, payload)
        return self._call_cli(tool, payload)

    def _call_endpoint(self, tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert self.config.endpoint is not None
        data = json.dumps({"tool": tool, "arguments": payload}).encode()
        request = urllib.request.Request(
            self.config.endpoint.rstrip("/") + "/cli",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            raise RuntimeError(f"codebase-memory endpoint failed: {exc.code} {body}") from exc

    def _call_cli(self, tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        binary = self._binary_path()
        if binary is None:
            raise RuntimeError(f"codebase-memory binary not found: {self.config.binary}")
        completed = subprocess.run(
            [str(binary), "cli", tool, json.dumps(payload)],
            check=True,
            capture_output=True,
            text=True,
            timeout=self.config.timeout_seconds,
        )
        output = completed.stdout.strip()
        start = output.find("{")
        if start < 0:
            raise RuntimeError(f"codebase-memory returned non-json output: {output[:200]}")
        return json.loads(output[start:])

    def _binary_path(self) -> Path | None:
        configured = Path(self.config.binary).expanduser()
        if configured.exists():
            return configured
        found = shutil.which("codebase-memory-mcp")
        if found:
            return Path(found)
        return None

    def _candidates(self, result: dict[str, Any]) -> list[CodebaseCandidate]:
        candidates: list[CodebaseCandidate] = []
        for item in result.get("results", []):
            file_path = item.get("file_path") or item.get("file")
            start_line = item.get("start_line") or item.get("line") or 1
            if not file_path:
                continue
            candidates.append(
                CodebaseCandidate(
                    file_path=str(file_path),
                    start_line=int(start_line),
                    end_line=item.get("end_line"),
                    label=item.get("label"),
                    name=item.get("name") or item.get("node"),
                    rank=item.get("rank"),
                )
            )
        return candidates


_CLIENT = CodebaseMemoryClient()


def get_codebase_memory_client() -> CodebaseMemoryClient:
    return _CLIENT


def _normalize_index_result(result: dict[str, Any]) -> dict[str, Any]:
    if "ok" in result:
        return result
    if result.get("status") in {"indexed", "ready"}:
        return {"ok": True, **result}
    return {"ok": False, **result}
