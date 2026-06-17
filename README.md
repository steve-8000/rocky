# rocky

OpenAI-compatible LLM server for Apple Silicon (M4 Max 64GB).  
MLX-native inference. No external dependencies beyond Python packages.

## Requirements

- macOS 13+ / Apple Silicon
- Python 3.10+
- [uv](https://docs.astral.sh/uv/)

## Install

```bash
git clone https://github.com/steve-8000/rocky
cd rocky
uv sync
```

## Start

```bash
make serve          # gemma4-12b (default, port 7777)
make serve-qwen3.6-27b
make serve-qwen3.6-35b
```

Or directly:

```bash
uv run rocky serve
uv run rocky serve qwen3.6-27b --port 7777
```

## Presets

| preset | model | max_tokens |
|---|---|---|
| `gemma4-12b` | gemma-4-12b-qat-4bit | 32768 |
| `qwen3.6-27b` | qwen3.6-27b-4bit | 32768 |
| `qwen3.6-35b` | qwen3.6-35b-4bit | 32768 |

```bash
uv run rocky presets
```

## Connect

**Endpoint:** `http://127.0.0.1:7777/v1`

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:7777/v1", api_key="x")
r = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)
```

**Cursor / Claude Code / Codex CLI**

```
base_url: http://127.0.0.1:7777/v1
api_key:  x
model:    default
```

## Run as service (launchd)

```bash
make install-service    # start on login, auto-restart
make uninstall-service  # remove

make status   # check
make logs     # tail logs
make restart  # restart
make health   # curl /health
```

## Config

Copy `.env.example` → `.env`:

| variable | default | |
|---|---|---|
| `ROCKY_PRESET` | `gemma4-12b` | model preset |
| `ROCKY_HOST` | `127.0.0.1` | bind address |
| `ROCKY_PORT` | `7777` | port |
| `ROCKY_API_KEY` | _(none)_ | bearer token |
| `ROCKY_EMBEDDING_MODEL` | _(none)_ | `/v1/embeddings` model |

## Endpoints

| | |
|---|---|
| `POST /v1/chat/completions` | chat (streaming supported) |
| `POST /v1/completions` | raw completions |
| `POST /v1/embeddings` | embeddings |
| `GET  /v1/models` | model list |
| `GET  /health` | liveness |

## License

Apache-2.0
