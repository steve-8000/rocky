# Rocky

Rocky is a local MCP backend for coding agents. It serves two jobs from one process:

- a streamable-HTTP MCP server at `POST /mcp`
- a local codebase backend built around the bundled `rocky-codebase` engine

The current repo state is **MCP-first and ML-free**. The checked-in runtime no longer ships model-serving routes from the main entrypoint; `rocky.mcp_app` mounts the MCP surface, the bounded native codebase APIs, and the background auto-index supervisor.

## What Rocky provides

- **Managed skills registry** backed by Markdown files plus `manifest.json`
- **Codebase tools** proxied from the native `rocky-codebase` engine
- **Bounded profile workflow** for plan/read/validate/expand codebase access
- **Local-only operation** by default: skills, plans, and indexes stay on disk
- **Amaze-ready MCP config** via the checked-in `.mcp.json`

## Runtime surfaces

| Surface | Method | Path | Notes |
| --- | --- | --- | --- |
| MCP | `POST` | `/mcp` | JSON-RPC initialize, tools/list, tools/call, ping |
| MCP probe | `GET` | `/mcp` | Returns `405`; Rocky does not expose server-push SSE |
| Health | `GET` | `/healthz` | Lightweight app readiness probe |
| Codebase status | `GET` | `/v1/codebase/status` | Backend configuration and availability |
| Profile catalog | `GET` | `/v1/codebase/profiles` | Lists bounded-context profiles |
| Profile health | `GET` | `/v1/codebase/health` | Collector and plan-store status |
| Auto-index status | `GET` | `/v1/codebase/auto_index/status` | Background refresh supervisor snapshot |
| Plan | `POST` | `/v1/codebase/plan` | Build a bounded read plan |
| Plan readback | `GET` | `/v1/codebase/plan/{plan_id}` | Read a stored plan |
| Plan delete | `DELETE` | `/v1/codebase/plan/{plan_id}` | Remove a stored plan |
| Read points | `POST` | `/v1/codebase/read` | Fetch selected plan points |
| Validate points | `POST` | `/v1/codebase/validate_points` | Check point freshness |
| Expand cluster | `POST` | `/v1/codebase/expand` | Expand a deferred cluster |
| Graph wrapper | `POST` | `/v1/rocky/codebase/search_graph` | Scope-aware proxy to engine `search_graph` |
| Code wrapper | `POST` | `/v1/rocky/codebase/search_code` | Scope-aware proxy to engine `search_code` |
| Generic wrapper | `POST` | `/v1/rocky/codebase/call` | Scope-aware proxy to another engine tool |

Removed native routes include legacy `/v1/search`, `/v1/context/build`, and raw `/v1/codebase/index|search_graph|search_code|call` endpoints.

## MCP tools

Rocky merges two tool families into one MCP server:

- **Skills:** `skill_search`, `skill_get`, `skill_upsert`, `skill_delete`, `skill_list`
- **Codebase:** engine-provided tools such as `index_repository`, `detect_changes`, `index_status`, `search_graph`, `search_code`, `get_code_snippet`, `trace_path`, `get_architecture`, and `query_graph`

Unknown tool names are returned as tool errors instead of crashing the server. `resources/list`, `resources/templates/list`, and `prompts/list` are intentionally empty.

## Skill storage

Skills live under `ROCKY_SKILLS_DIR` as flat Markdown files plus a manifest:

```text
ROCKY_SKILLS_DIR/
  manifest.json
  <skill-name>.md
```

Each skill file contains YAML frontmatter and a Markdown body:

```markdown
---
name: rocky-example
summary: When to use this skill
tags:
  - rocky
version: 1
---
Procedure, caveats, commands, verification notes.
```

`skill_upsert` sanitizes the kebab-case name, rewrites `<name>.md`, updates `manifest.json`, increments `version`, and triggers reindexing of the skills directory.

## Quick start

### Local development

```bash
cd /Users/steve/amaze_s3/rocky
uv sync
ROCKY_RUNTIME_ROOT=$PWD/.rocky \
ROCKY_API_KEY=rocky-secret \
uv run rocky serve --host 127.0.0.1 --port 7777
```

Equivalent direct ASGI launch:

```bash
ROCKY_RUNTIME_ROOT=$PWD/.rocky \
ROCKY_API_KEY=rocky-secret \
uvicorn rocky.mcp_app:app --host 127.0.0.1 --port 7777
```

The CLI still accepts legacy preset names for compatibility, but the runtime is MCP-only now. Passing `--no-mcp` exits with an error, and unsupported legacy serve args are ignored.

### Amaze workspace config

The checked-in `.mcp.json` exposes Rocky to Amaze as `rocky-skills`:

```json
{
  "mcpServers": {
    "rocky-skills": {
      "type": "http",
      "url": "http://localhost:7777/mcp",
      "headers": {
        "Authorization": "Bearer rocky-secret"
      }
    }
  }
}
```

## Current configuration defaults

### Core runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROCKY_HOST` | `127.0.0.1` | Bind host for `rocky serve` |
| `ROCKY_PORT` | `7777` | Bind port for `rocky serve` |
| `ROCKY_API_KEY` | unset | When set, clients must send `Authorization: Bearer <key>` |
| `ROCKY_SKILLS_DIR` | `~/.rocky/skills` | Managed skills directory |
| `ROCKY_RUNTIME_ROOT` | `~/.rocky` | Root for native plan storage |

### Codebase backend

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROCKY_CODEBASE_ENABLED` | `true` | Enables codebase integration |
| `ROCKY_CODEBASE_AUTO_INDEX` | `true` | Allows tool/profile workflows to auto-index before querying |
| `ROCKY_CODEBASE_BINARY` | `<repo>/bin/rocky-codebase` | Local launcher/binary path |
| `ROCKY_CODEBASE_ENDPOINT` | unset | Optional remote engine `/rpc` endpoint |
| `ROCKY_CODEBASE_PROJECT` | unset | Explicit engine project name |
| `ROCKY_CODEBASE_PROJECT_PATH` | unset | Default filesystem root used to resolve a project |
| `ROCKY_CODEBASE_TIMEOUT_SECONDS` | `30` | Engine call timeout |
| `ROCKY_CODEBASE_STALE_AFTER_SECONDS` | `300` | Index freshness window |

### Background auto-refresh

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROCKY_CODEBASE_AUTO_REFRESH` | `true` | Enables the background git-change watcher |
| `ROCKY_CODEBASE_POLL_INTERVAL_SECONDS` | `2.0` | Poll cadence for tracked repos |
| `ROCKY_CODEBASE_REGISTRY_INTERVAL_SECONDS` | `60.0` | How often Rocky refreshes the indexed-project registry |
| `ROCKY_CODEBASE_INDEX_DEBOUNCE_SECONDS` | `3.0` | Delay before indexing after a repo becomes dirty |
| `ROCKY_CODEBASE_INDEX_COOLDOWN_SECONDS` | `10.0` | Cooldown between index runs |
| `ROCKY_CODEBASE_INDEX_MODE` | `fast` | `index_repository` mode used by the supervisor |

### Optional collector tuning

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROCKY_AST_GREP_BINARY` | auto-detect | Optional `ast-grep` binary path |
| `ROCKY_AST_GREP_TOTAL_TIMEOUT_SECONDS` | `3.0` | Total AST-grep collector timeout |
| `ROCKY_LSP_COLLECTOR_COMMAND` | unset | Optional LSP bridge command |
| `ROCKY_LSP_COLLECTOR_TIMEOUT_SECONDS` | `2.0` | LSP collector timeout |
| `ROCKY_LEXICAL_MAX_FILE_BYTES` | `1048576` | Max file size scanned by lexical fallback |
| `ROCKY_LEXICAL_TIMEOUT_SECONDS` | `2.0` | Lexical collector timeout |

## Checked-in operator workflow

### Makefile

The repo ships these developer targets:

```bash
make install
make serve ROCKY_API_KEY=rocky-secret
make health
make status
make logs
```

`make serve` starts `rocky.mcp_app` through `.venv/bin/uvicorn` and sets `ROCKY_RUNTIME_ROOT=$(CURDIR)/.rocky`.

### launchd caveat

`Makefile` still includes `install-service`, `uninstall-service`, and `restart` targets that expect `launchd/dev.rocky.plist`, but the checked-in `launchd/` directory is currently empty. If you want a launchd-managed service, create and maintain your own plist before using those targets.

## Deployment

### Full MCP + codebase container

`deploy/mcp/Containerfile.full` builds the ML-free Python MCP app together with the native `rocky-codebase` binary.

Build flow from the repo comments:

```bash
container build -t rocky-codebase:linux -f <codebase-memory-mcp>/deploy/Dockerfile.linux <codebase-memory-mcp>
container build -t rocky-mcp:full -f deploy/mcp/Containerfile.full .
```

The full image sets:

```text
ROCKY_MCP_ENABLED=true
ROCKY_SKILLS_DIR=/skills
ROCKY_CODEBASE_ENABLED=true
ROCKY_CODEBASE_BINARY=/usr/local/bin/rocky-codebase
ROCKY_HOST=0.0.0.0
ROCKY_PORT=7777
```

The build also imports `rocky.mcp_app` and asserts that heavy ML modules do not leak into the MCP image.

## Verification

### Quick HTTP checks

```bash
curl http://127.0.0.1:7777/healthz
```

```bash
curl -s http://127.0.0.1:7777/mcp \
  -H 'Authorization: Bearer rocky-secret' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"0"}}}'
```

```bash
curl http://127.0.0.1:7777/v1/codebase/auto_index/status
```

### Focused tests

```bash
python3 -m pytest \
  tests/test_mcp_server.py \
  tests/test_codebase_tools_list.py \
  tests/test_native_search_flow.py \
  tests/test_profile_engine_stage.py \
  tests/test_auto_index.py
```

### Live surface check

```bash
python3 scripts/random_live_surface_check.py
```

## Development notes

- Package metadata currently reports version `0.1.2` in `pyproject.toml`.
- `rocky.mcp_app` is the supported ML-free runtime entrypoint.
- Full codebase-tool coverage requires a working `rocky-codebase` binary; skill tools still work without it.
- Native plans are stored under `<ROCKY_RUNTIME_ROOT>/codebase-plans`.

## License and attribution

Rocky is MIT licensed; see [`LICENSE`](LICENSE).

The bundled codebase engine is derived from [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), also MIT licensed. Preserve the upstream license and third-party notices when redistributing the engine.
