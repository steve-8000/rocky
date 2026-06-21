# Rocky

Rocky is a local backend package that runs three agent-facing capabilities in one process:

- **LLM runtime**: OpenAI-compatible chat completions backed by the FastContext preset.
- **Search engine**: caller-ready source/context packaging for file, code, document, log, metrics, and config targets.
- **Durable memory**: Xenonite-compatible global/project/path scoped memory without a separate embedding model.

Rocky is intended to be started as one long-running local service. Agents call Rocky over HTTP; MCP can be added later as an adapter, but the native API is the primary integration surface.

## Quick start

```bash
cd /Users/steve/llm/rocky
.venv/bin/python -m rocky serve
```

Default runtime:

```text
host: 127.0.0.1
port: 30000
preset: fastcontext
model: microsoft/FastContext-1.0-4B-SFT
tool parser: qwen
memory root: ~/.rocky/memory
```

No extra config is required for the integrated backend. Advanced overrides are environment variables:

```bash
ROCKY_HOST=0.0.0.0 ROCKY_PORT=30000 .venv/bin/python -m rocky serve
```

## Installation

Rocky is a Python package. For local development:

```bash
cd /Users/steve/llm/rocky
python3 -m venv .venv
.venv/bin/pip install -e .
```

If the virtualenv already exists, start directly with:

```bash
.venv/bin/python -m rocky serve
```

## Operator checks

Runtime status:

```bash
curl http://127.0.0.1:30000/v1/runtime/status
```

Chat completion:

```bash
curl http://127.0.0.1:30000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "microsoft/FastContext-1.0-4B-SFT",
    "messages": [{"role": "user", "content": "Say ok."}],
    "max_tokens": 8
  }'
```

Store and recall memory:

```bash
curl http://127.0.0.1:30000/v1/memory/store \
  -H 'content-type: application/json' \
  -d '{
    "text": "Rocky serves LLM, search, and memory together.",
    "scope": {"kind": "global"},
    "tags": ["operator"]
  }'

curl http://127.0.0.1:30000/v1/memory/recall \
  -H 'content-type: application/json' \
  -d '{
    "query": "LLM search memory together",
    "scope": {"kind": "global"},
    "limit": 5
  }'
```

Build a search/context payload:

```bash
curl http://127.0.0.1:30000/v1/context/build \
  -H 'content-type: application/json' \
  -d '{
    "query": "Where is integrated context built?",
    "path": "/Users/steve/llm/rocky",
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
| `POST /v1/context/build` | Combines memory recall, runtime metadata, and search evidence into one caller-ready payload. |
| `POST /v1/memory/store` | Stores a durable memory fact. |
| `POST /v1/memory/recall` | Recalls visible memory for global/project/path scope. |
| `POST /v1/memory/delete` | Deletes memory by id, exact text, or text prefix. |
| `POST /v1/memory/optimize` | Rewrites canonical memory indexes and removes duplicates. |

## Architecture

```text
agent / amaze
    |
    | HTTP native API
    v
Rocky integrated backend
    |
    +-- LLM runtime
    |     - default preset: fastcontext
    |     - model: microsoft/FastContext-1.0-4B-SFT
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

- The LLM runtime runs FastContext and exposes OpenAI-compatible chat.
- The search engine does not try to be a second LLM. It packages exact targets and nearby context for the calling agent.
- Memory is durable project intelligence. It uses Rocky's runtime path, not an independent embedding model.
- `context/build` is the primary agent convenience endpoint: memory first, search evidence second, runtime metadata included.

## Memory scopes

Memory supports three scopes:

```json
{"kind": "global"}
{"kind": "project", "project_path": "/path/to/project"}
{"kind": "path", "project_path": "/path/to/project", "path": "/path/to/project/subdir"}
```

Visibility rules:

- Global facts are visible everywhere.
- Project facts are visible inside the same project.
- Path facts are visible only for the same project/path.
- Unrelated projects cannot recall each other's project/path facts.

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

Rocky writes durable memory to:

```text
~/.rocky/memory
```

Temporary local logs and pid files should stay outside the repo, for example:

```text
/tmp/rocky_integrated_30000.log
/tmp/rocky_integrated_30000.pid
```

## Development notes

- Keep deployable source in `rocky/`, `scripts/`, and `tests/`.
- Do not commit `.harness/`, virtualenvs, pycache, local logs, pid files, or memory stores.
- Prefer one-command operation: `python -m rocky serve`.
- Native HTTP is the primary integration path for amaze and other agents.
