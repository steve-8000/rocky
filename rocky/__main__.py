from __future__ import annotations

import argparse
import sys

from rocky.serve import EMBEDDING_PRESETS, PRESETS, run, run_embed


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="rocky",
        description="OpenAI-compatible server for M4 Max 64GB",
    )
    sub = p.add_subparsers(dest="command")

    srv = sub.add_parser("serve", help="Launch the LLM API server")
    srv.add_argument(
        "preset",
        nargs="?",
        default=None,
        choices=list(PRESETS),
        help=f"Model preset (default: 35b). Available: {', '.join(PRESETS)}",
    )
    srv.add_argument("--host", default=None, help="Bind host (default: 127.0.0.1 or ROCKY_HOST)")
    srv.add_argument("--port", type=int, default=None, help="Port (default: 8000 or ROCKY_PORT)")
    srv.add_argument("--api-key", default=None, dest="api_key", help="Bearer token (or ROCKY_API_KEY)")
    srv.add_argument(
        "--embedding-model",
        default=None,
        dest="embedding_model",
        help="Pre-load embedding model for /v1/embeddings (or ROCKY_EMBEDDING_MODEL)",
    )
    srv.add_argument(
        "--embedding-preset",
        default=None,
        dest="embedding_preset",
        choices=list(EMBEDDING_PRESETS),
        help=f"Embedding model preset. Available: {', '.join(EMBEDDING_PRESETS)}",
    )
    srv.add_argument("extra", nargs=argparse.REMAINDER, help="Extra flags forwarded to rapid-mlx serve")

    emb = sub.add_parser("embed", help="Launch embedding-only server")
    emb.add_argument(
        "preset",
        nargs="?",
        default=None,
        choices=list(EMBEDDING_PRESETS),
        help=f"Embedding preset (default: qwen3-embed-0.6b). Available: {', '.join(EMBEDDING_PRESETS)}",
    )
    emb.add_argument("--host", default=None)
    emb.add_argument("--port", type=int, default=None, help="Port (default: 7778 or ROCKY_EMBED_PORT)")
    emb.add_argument("--api-key", default=None, dest="api_key")

    sub.add_parser("presets", help="List available model presets")
    sub.add_parser("embedding-presets", help="List available embedding model presets")

    return p


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "serve":
        embedding_model = args.embedding_model
        if not embedding_model and args.embedding_preset:
            embedding_model = EMBEDDING_PRESETS[args.embedding_preset]
        run(
            preset_name=args.preset,
            host=args.host,
            port=args.port,
            api_key=args.api_key,
            embedding_model=embedding_model,
            extra=args.extra,
        )
    elif args.command == "embed":
        run_embed(
            preset_name=args.preset,
            host=args.host,
            port=args.port,
            api_key=args.api_key,
        )
    elif args.command == "presets":
        print(f"{'preset':<14} {'alias':<38} {'prefill_step':<14} max_tokens")
        print("-" * 74)
        for name, preset in PRESETS.items():
            emb = "+ embed" if preset.embedding_model else "-"
            print(f"{name:<14} {preset.alias:<38} {preset.prefill_step_size:<14} {preset.max_tokens}  {emb}")
    elif args.command == "embedding-presets":
        print(f"{'preset':<20} {'model'}")
        print("-" * 72)
        for name, model in EMBEDDING_PRESETS.items():
            print(f"{name:<20} {model}")
    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()
