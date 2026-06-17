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

## LLM Presets

| preset | model (HuggingFace) | max_tokens | tool call | thinking |
|---|---|---|---|---|
| `gemma4-12b` ✦ | [mlx-community/gemma-4-12B-it-qat-4bit](https://huggingface.co/mlx-community/gemma-4-12B-it-qat-4bit) | 32768 | ✅ gemma4 | off |
| `qwen3.6-27b` | [mlx-community/Qwen3.6-27B-4bit](https://huggingface.co/mlx-community/Qwen3.6-27B-4bit) | 32768 | ✅ qwen3_coder_xml | on |
| `qwen3.6-35b` | [mlx-community/Qwen3.6-35B-A3B-4bit](https://huggingface.co/mlx-community/Qwen3.6-35B-A3B-4bit) | 32768 | ✅ qwen3_coder_xml | on |

✦ default preset

```bash
# list presets
uv run rocky presets

# load a specific preset (downloads model on first run)
make serve                  # gemma4-12b (default)
make serve-qwen3.6-27b
make serve-qwen3.6-35b

# or directly
uv run rocky serve gemma4-12b
uv run rocky serve qwen3.6-27b
uv run rocky serve qwen3.6-35b
```

## Embedding Presets

| preset | model (HuggingFace) | dim | default |
|---|---|---|---|
| `qwen3-embed-0.6b` ✦ | [mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ](https://huggingface.co/mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ) | 1024 | ✅ |
| `qwen3-embed-4b` | [mlx-community/Qwen3-Embedding-4B-4bit-DWQ](https://huggingface.co/mlx-community/Qwen3-Embedding-4B-4bit-DWQ) | 2560 | |
| `qwen3-embed-8b` | [mlx-community/Qwen3-Embedding-8B-4bit-DWQ](https://huggingface.co/mlx-community/Qwen3-Embedding-8B-4bit-DWQ) | 4096 | |
| `nomic` | [mlx-community/nomicai-modernbert-embed-base-4bit](https://huggingface.co/mlx-community/nomicai-modernbert-embed-base-4bit) | 768 | |
| `gemma-embed` | [mlx-community/embeddinggemma-300m-4bit](https://huggingface.co/mlx-community/embeddinggemma-300m-4bit) | 1152 | |

✦ default preset

```bash
# list embedding presets
uv run rocky embedding-presets

# load embedding server (port 7778)
make embed                                          # qwen3-embed-0.6b (default)
uv run rocky embed qwen3-embed-4b --port 7778
uv run rocky embed nomic --port 7778
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
