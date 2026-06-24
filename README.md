# Rocky

Rocky is a local backend package that runs three agent-facing capabilities in one process:

- **LLM runtime**: OpenAI-compatible chat completions backed by the default Gemma 4 preset.
- **Search engine**: caller-ready source/context packaging for file, code, document, log, metrics, and config targets.
- **Skills registry**: reusable procedures stored as Markdown and served to external agents over a spec-compliant MCP endpoint, ranked by Rocky's own code search.

Rocky is intended to be started as one long-running local service. Agents call Rocky over its native HTTP API, and external MCP clients (Claude, Cursor, Codex, custom agents) connect to the streamable-HTTP MCP server at `POST /mcp`.

## Quick start

```bash
cd /Users/steve/amaze_s3/rocky
uv sync
mkdir -p .rocky/logs
ROCKY_PRESET=gemma4-12b \
ROCKY_RUNTIME_ROOT=$PWD/.rocky \
uv run rocky serve --host 127.0.0.1 --port 7777
```

Embedding server:

```bash
cd /Users/steve/amaze_s3/rocky
ROCKY_RUNTIME_ROOT=$PWD/.rocky \
uv run rocky embed qwen3-embed-4b --host 127.0.0.1 --port 7778
```

Default launchd runtime in this workspace:

```text
host: 127.0.0.1
llm port: 7777
embed port: 7778
preset: gemma4-12b
embedding preset: qwen3-embed-4b
codebase backend: /Users/steve/amaze_s3/rocky/bin/rocky-codebase
memory root: /Users/steve/amaze_s3/rocky/.rocky/memory
logs: /Users/steve/amaze_s3/rocky/.rocky/logs
```

## Installation

Rocky is a Python package. In this workspace:

```bash
cd /Users/steve/amaze_s3/rocky
uv sync
```

If the virtualenv already exists, start directly with:

```bash
ROCKY_RUNTIME_ROOT=$PWD/.rocky .venv/bin/python -m rocky serve
```

## Operator checks

Runtime status:

```bash
curl http://127.0.0.1:7777/v1/runtime/status
```

Rocky codebase backend status:

```bash
curl http://127.0.0.1:7777/v1/rocky/codebase/status
```

Chat completion:

```bash
curl http://127.0.0.1:7777/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "mlx-community/gemma-4-12B-it-qat-4bit",
    "messages": [{"role": "user", "content": "Say ok."}],
    "max_tokens": 8
  }'
```

Store and recall memory:

```bash
curl http://127.0.0.1:7777/v1/memory/store \
  -H 'content-type: application/json' \
  -d '{
    "text": "Rocky serves LLM, search, and memory together.",
    "scope": {"kind": "global"},
    "tags": ["operator"]
  }'

curl http://127.0.0.1:7777/v1/memory/recall \
  -H 'content-type: application/json' \
  -d '{
    "query": "LLM search memory together",
    "scope": {"kind": "global"},
    "limit": 5
  }'
```

Build a search/context payload:

```bash
curl http://127.0.0.1:7777/v1/context/build \
  -H 'content-type: application/json' \
  -d '{
    "query": "Where is integrated context built?",
    "path": "/Users/steve/amaze_s3/rocky",
    "final_answer": "<final_answer>rocky/integration.py:1-40 - integration pipeline</final_answer>",
    "scope": {"kind": "global"}
  }'
```

## Native API

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/runtime/status` | Reports Rocky module readiness and selected LLM preset. |
| `POST /v1/chat/completions` | OpenAI-compatible LLM runtime endpoint. |
| `POST /v1/search` | Converts a model final answer with file/line targets into deterministic evidence blocks. |
| `POST /v1/context/build` | Combines runtime metadata and search evidence into one caller-ready payload. |
| `GET /v1/codebase/status` | Reports whether Rocky can reach the configured Amaze/codebase backend binary or endpoint. |
| `POST /mcp` | Streamable-HTTP MCP server: skill tools (`skill_search/get/upsert/delete/list`) plus proxied codebase tools (`search_graph`, `get_code_snippet`, …) for external agents. Bearer auth. |
| `GET /mcp` | Returns `405` — Rocky does not push server-initiated SSE. |

## MCP server

Rocky exposes a spec-compliant **streamable-HTTP MCP server** so external agents
(Claude, Cursor, Codex, custom clients) can use Rocky's skills and code search
without the native API.

- **Endpoint**: `POST /mcp` (JSON-RPC 2.0, single object or batch). `GET /mcp` → `405`.
- **Auth**: `Authorization: Bearer $ROCKY_API_KEY` (open when no key is configured).
- **Tools**: 5 skill tools (`skill_search`, `skill_get`, `skill_upsert`, `skill_delete`, `skill_list`) plus codebase tools (`search_graph`, `trace_path`, `get_code_snippet`, `get_architecture`, …) proxied from the code engine.
- **Skills store**: Markdown files under `ROCKY_SKILLS_DIR` (default `~/.rocky/skills`); `skill_upsert` writes frontmatter + body and reindexes via Rocky's code search.
- **Toggle**: enabled by default; `ROCKY_MCP_ENABLED=false` or `rocky serve --no-mcp` disables it, and `rocky serve --skills-dir PATH` overrides the store.

Example external-client handshake:

```bash
curl -s http://127.0.0.1:7777/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"0"}}}'
```

## Architecture

```text
agent / amaze
    |
    | HTTP native API
    v
Rocky integrated backend
    |
    +-- LLM runtime
    |     - default preset: gemma4-12b
    |     - model: gemma-4-12b-qat-4bit
    |     - OpenAI-compatible /v1/chat/completions
    |
    +-- Search engine
    |     - exact file/line evidence packaging
    |     - suffix path recovery
    |     - code/document/log/metrics/config context policies
    |     - deterministic caller-ready context windows
    |
    +-- Durable memory
          - Xenonite-compatible scopes: global, project, path
          - JSONL durable log plus canonical index
          - lexical recall and dedupe/optimize
          - no separate embedding model
```

### Design boundaries

- The LLM runtime runs the configured/default preset and exposes OpenAI-compatible chat.
- The search engine does not try to be a second LLM. It packages exact targets and nearby context for the calling agent.
- Skills are durable, reusable procedures stored as Markdown; Rocky indexes them with its own code search so `skill_search` returns ranked summaries.
- `context/build` is the primary agent convenience endpoint: search evidence plus runtime metadata, caller-ready.

## Search output

Search APIs return deterministic evidence blocks. A block includes:

- `path`
- `start_line` / `end_line`
- `context_start_line` / `context_end_line`
- `snippet`
- type-aware packaging metadata

The goal is that an agent receiving the payload does not need another broad read just to locate the relevant source.

## Validation

Run the stage tests:

```bash
PYTHONPYCACHEPREFIX=/tmp/rocky_repo_pycache PYTHONDONTWRITEBYTECODE=1 \
  .venv/bin/python -m pytest -q -p no:cacheprovider \
  tests/test_llm_runtime_stage.py \
  tests/test_search_stage.py \
  tests/test_memory_stage.py \
  tests/test_integration_stage.py
```

Run the final gate:

```bash
PYTHONPYCACHEPREFIX=/tmp/rocky_repo_pycache PYTHONDONTWRITEBYTECODE=1 \
  .venv/bin/python scripts/final_goal_gate.py
```

Expected result:

```text
stage threshold: 95
final threshold: 92
current stage scores: 100 / 100 / 100 / 100
```

Compile changed modules:

```bash
PYTHONPYCACHEPREFIX=/tmp/rocky_repo_pycache PYTHONDONTWRITEBYTECODE=1 \
  .venv/bin/python -m py_compile \
  rocky/serve.py rocky/core/server.py rocky/core/routes/rocky_native.py \
  rocky/search/*.py rocky/memory/*.py rocky/integration.py
```

## Runtime files

With `ROCKY_RUNTIME_ROOT=/Users/steve/amaze_s3/rocky/.rocky`, Rocky writes durable memory to:

```text
/Users/steve/amaze_s3/rocky/.rocky/memory
```

The checked-in launchd plists in `launchd/` also send service logs to:

```text
/Users/steve/amaze_s3/rocky/.rocky/logs
```

## Development notes

- Keep deployable source in `rocky/`, `scripts/`, and `tests/`.
- Do not commit `.harness/`, virtualenvs, pycache, local logs, pid files, or memory stores.
- Prefer one-command operation: `python -m rocky serve`.
- Native HTTP is the primary integration path for amaze and other agents.
