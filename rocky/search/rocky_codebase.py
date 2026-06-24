from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


SearchScope = Literal["cwd", "workspace", "parent_1", "parent_2", "explicit_roots"]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class RockyCodebaseConfig:
    enabled: bool = True
    auto_index: bool = True
    endpoint: str | None = None
    binary: str = "/Users/steve/amaze_s3/rocky/bin/rocky-codebase"
    project: str | None = None
    project_path: str | None = None
    timeout_seconds: float = 30.0
    stale_after_seconds: float = 300.0

    @classmethod
    def from_env(cls) -> "RockyCodebaseConfig":
        return cls(
            enabled=_env_bool("ROCKY_CODEBASE_ENABLED", True),
            auto_index=_env_bool("ROCKY_CODEBASE_AUTO_INDEX", True),
            endpoint=os.getenv("ROCKY_CODEBASE_ENDPOINT") or None,
            binary=os.getenv("ROCKY_CODEBASE_BINARY") or cls.binary,
            project=os.getenv("ROCKY_CODEBASE_PROJECT") or None,
            project_path=os.getenv("ROCKY_CODEBASE_PROJECT_PATH") or None,
            timeout_seconds=float(os.getenv("ROCKY_CODEBASE_TIMEOUT_SECONDS", "30")),
            stale_after_seconds=float(os.getenv("ROCKY_CODEBASE_STALE_AFTER_SECONDS", "300")),
        )


@dataclass(frozen=True)
class CodebaseCandidate:
    file_path: str
    start_line: int
    end_line: int | None = None
    label: str | None = None
    name: str | None = None
    rank: float | None = None
    source: str = "rocky-codebase"

    def target(self) -> str:
        return f"{self.file_path}:{max(self.start_line, 1)}"


class RockyCodebaseClient:
    _IGNORED_STATE_DIRS = frozenset(
        {
            ".git",
            ".harness",
            ".rocky",
            ".venv",
            "__pycache__",
            "build",
            "node_modules",
            "vendor",
        }
    )

    def __init__(self, config: RockyCodebaseConfig | None = None) -> None:
        self.config = config or RockyCodebaseConfig.from_env()
        self._indexed_at: dict[str, float] = {}
        self._repo_tokens: dict[str, str | None] = {}
        self._tools_cache: list[dict] | None = None

    def default_repo_path(self) -> Path:
        raw = self.config.project_path or "."
        return Path(raw).expanduser().resolve()

    def ensure_default_indexed(self) -> dict[str, Any]:
        return self.ensure_indexed(self.default_repo_path())

    def resolve_search_scope(
        self,
        *,
        path: str | Path = ".",
        cwd: str | Path | None = None,
        scope: SearchScope | str = "workspace",
        roots: list[str] | tuple[str, ...] | None = None,
        max_parent_depth: int | None = None,
    ) -> dict[str, Any]:
        requested_scope = str(scope or "workspace")
        if requested_scope not in {"cwd", "workspace", "parent_1", "parent_2", "explicit_roots"}:
            raise ValueError(f"unsupported codebase search scope: {requested_scope}")

        workspace_path = Path(path).expanduser().resolve()
        cwd_path = Path(cwd).expanduser().resolve() if cwd else workspace_path
        resolved_depth = max_parent_depth

        if requested_scope == "cwd":
            effective_roots = [cwd_path]
            resolved_depth = 0 if resolved_depth is None else resolved_depth
        elif requested_scope == "workspace":
            effective_roots = [workspace_path]
            resolved_depth = 0 if resolved_depth is None else resolved_depth
        elif requested_scope in {"parent_1", "parent_2"}:
            default_depth = 1 if requested_scope == "parent_1" else 2
            depth = default_depth if resolved_depth is None else max(0, int(resolved_depth))
            root = cwd_path
            for _ in range(depth):
                root = root.parent
            effective_roots = [root]
            resolved_depth = depth
        else:
            if not roots:
                raise ValueError("explicit_roots requires at least one root")
            effective_roots = [Path(root).expanduser().resolve() for root in roots]
            resolved_depth = 0 if resolved_depth is None else resolved_depth

        seen: set[str] = set()
        normalized_roots: list[str] = []
        for root in effective_roots:
            normalized = str(root)
            if normalized in seen:
                continue
            seen.add(normalized)
            normalized_roots.append(normalized)

        return {
            "requested_scope": requested_scope,
            "cwd": str(cwd_path),
            "workspace_path": str(workspace_path),
            "max_parent_depth": resolved_depth,
            "effective_roots": normalized_roots,
            "searched_roots": normalized_roots,
            "excluded_roots": [],
        }

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
        token = self._repo_state_token(repo)
        last = self._indexed_at.get(repo)
        if (
            last is not None
            and self._repo_tokens.get(repo) == token
            and now - last < self.config.stale_after_seconds
        ):
            return {"ok": True, "skipped": True, "reason": "fresh", "project": self.project_for_path(repo)}
        result = _normalize_index_result(self.index_repository(repo))
        if result.get("ok"):
            self._indexed_at[repo] = now
            self._repo_tokens[repo] = self._repo_state_token(repo)
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

    PASSTHROUGH_TOOLS = frozenset(
        {"get_code_snippet", "trace_path", "get_architecture", "query_graph"}
    )

    def call(self, tool: str, repo_path: str | Path, arguments: dict[str, Any]) -> dict[str, Any]:
        """Proxy a project-scoped graph tool (get_code_snippet, trace_path,
        get_architecture, query_graph) to the same rocky-codebase backend used by
        search_graph/search_code, so every tool shares one project/cache namespace."""
        if tool not in self.PASSTHROUGH_TOOLS:
            raise ValueError(f"unsupported codebase passthrough tool: {tool}")
        payload = dict(arguments)
        if not payload.get("project"):
            payload["project"] = self.project_for_path(repo_path)
        return self._call(tool, payload)

    def codebase_tools_list(self) -> list[dict]:
        if self._tools_cache is not None:
            return self._tools_cache
        try:
            if not self.config.enabled:
                raise RuntimeError("rocky codebase is disabled")
            if self.config.endpoint:
                tools = self._codebase_tools_list_endpoint()
            else:
                tools = self._codebase_tools_list_cli()
        except Exception:
            logging.getLogger(__name__).exception("failed to load rocky codebase tools list")
            return []

        normalized: list[dict] = []
        for item in tools:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not isinstance(name, str) or not name:
                continue
            description = item.get("description")
            input_schema = item.get("inputSchema")
            normalized.append(
                {
                    "name": name,
                    "description": description if isinstance(description, str) else "",
                    "inputSchema": input_schema if isinstance(input_schema, dict) else {},
                }
            )
        self._tools_cache = normalized
        return normalized

    def call_tool(self, tool: str, arguments: dict) -> dict:
        return self._call(tool, dict(arguments))

    def _codebase_tools_list_endpoint(self) -> list[dict]:
        assert self.config.endpoint is not None
        data = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {},
            }
        ).encode()
        request = urllib.request.Request(
            self.config.endpoint.rstrip("/") + "/rpc",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
            result = json.loads(response.read().decode())
        tools = result.get("result", {}).get("tools")
        if not isinstance(tools, list):
            raise RuntimeError("rocky codebase endpoint returned no tools list")
        return tools

    def _codebase_tools_list_cli(self) -> list[dict]:
        binary = self._binary_path()
        if binary is None:
            raise RuntimeError(f"rocky codebase binary not found: {self.config.binary}")

        requests = "\n".join(
            [
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-06-18",
                            "capabilities": {},
                            "clientInfo": {"name": "rocky", "version": "1.0"},
                        },
                    }
                ),
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {},
                    }
                ),
            ]
        ) + "\n"
        process = subprocess.Popen(
            [str(binary)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            stdout, stderr = process.communicate(
                input=requests,
                timeout=self.config.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            process.kill()
            stdout, stderr = process.communicate()
            raise RuntimeError("rocky codebase tools/list timed out") from exc

        for raw_line in stdout.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            start = line.find("{")
            if start < 0:
                continue
            try:
                message = json.loads(line[start:])
            except json.JSONDecodeError:
                continue
            result = message.get("result")
            if message.get("id") == 2 and isinstance(result, dict):
                tools = result.get("tools")
                if isinstance(tools, list):
                    return tools

        detail = stderr.strip() or stdout.strip() or f"exit code {process.returncode}"
        raise RuntimeError(f"rocky codebase tools/list response missing: {detail[:200]}")

    def _call(self, tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.config.enabled:
            raise RuntimeError("rocky codebase is disabled")
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
            raise RuntimeError(f"rocky codebase endpoint failed: {exc.code} {body}") from exc

    def _call_cli(self, tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        binary = self._binary_path()
        if binary is None:
            raise RuntimeError(f"rocky codebase binary not found: {self.config.binary}")
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
            raise RuntimeError(f"rocky codebase returned non-json output: {output[:200]}")
        return json.loads(output[start:])

    def _binary_path(self) -> Path | None:
        configured = Path(self.config.binary).expanduser()
        if configured.exists():
            return configured
        found = shutil.which("rocky-codebase")
        if found:
            return Path(found)
        return None

    def _repo_state_token(self, repo_path: str | Path) -> str | None:
        root = Path(repo_path).expanduser().resolve()
        if not root.exists():
            return None
        if root.is_file():
            return f"0:1:{root.stat().st_mtime_ns}"
        file_count = 0
        dir_count = 0
        latest_mtime_ns = 0
        for current_root, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(
                dirname for dirname in dirnames if dirname not in self._IGNORED_STATE_DIRS
            )
            current_path = Path(current_root)
            dir_count += 1
            try:
                latest_mtime_ns = max(latest_mtime_ns, current_path.stat().st_mtime_ns)
            except OSError:
                pass
            for filename in sorted(filenames):
                file_count += 1
                try:
                    latest_mtime_ns = max(latest_mtime_ns, (current_path / filename).stat().st_mtime_ns)
                except OSError:
                    continue
        return f"{dir_count}:{file_count}:{latest_mtime_ns}"

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


_CLIENT = RockyCodebaseClient()


def get_rocky_codebase_client() -> RockyCodebaseClient:
    return _CLIENT


def _normalize_index_result(result: dict[str, Any]) -> dict[str, Any]:
    if "ok" in result:
        return result
    if result.get("status") in {"indexed", "ready"}:
        return {"ok": True, **result}
    return {"ok": False, **result}
