from __future__ import annotations

import argparse
import sys

from rocky.serve import PRESETS, run


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
    srv.add_argument("extra", nargs=argparse.REMAINDER, help="Extra flags forwarded to rapid-mlx serve")

    sub.add_parser("presets", help="List available model presets")

    return p


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "serve":
        run(
            preset_name=args.preset,
            host=args.host,
            port=args.port,
            api_key=args.api_key,
            embedding_model=args.embedding_model,
            extra=args.extra,
        )
    elif args.command == "presets":
        print(f"{'preset':<12} {'alias':<35} {'prefill_step':<14} max_tokens")
        print("-" * 72)
        for name, preset in PRESETS.items():
            flags = " ".join(preset.extra_flags) or "-"
            print(f"{name:<12} {preset.alias:<35} {preset.prefill_step_size:<14} {preset.max_tokens}  {flags}")
    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()
