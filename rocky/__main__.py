from __future__ import annotations

import argparse
import sys

from rocky.serve import PRESETS, run


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="rocky",
        description="Skills and codebase MCP backend for agent tooling",
    )
    sub = p.add_subparsers(dest="command")

    srv = sub.add_parser("serve", help="Launch the MCP skills+codebase server")
    srv.add_argument(
        "preset",
        nargs="?",
        default=None,
        choices=list(PRESETS),
        help="Legacy accepted preset name; MCP-only serving ignores model loading.",
    )
    srv.add_argument("--host", default=None, help="Bind host (default: 127.0.0.1 or ROCKY_HOST)")
    srv.add_argument("--port", type=int, default=None, help="Port (default: 7777 or ROCKY_PORT)")
    srv.add_argument("--api-key", default=None, dest="api_key", help="Bearer token (or ROCKY_API_KEY)")
    srv.add_argument(
        "--skills-dir", default=None, dest="skills_dir",
        help="Skills directory served by the MCP endpoint (or ROCKY_SKILLS_DIR)",
    )
    srv.add_argument(
        "--mcp", dest="mcp", action="store_true", default=None,
        help="Accepted for compatibility; MCP is enabled by default",
    )
    srv.add_argument(
        "--no-mcp", dest="mcp", action="store_false",
        help="Reject startup because Rocky 0.1.1 is MCP-only",
    )
    srv.add_argument("extra", nargs=argparse.REMAINDER, help="Ignored legacy serve flags")

    sub.add_parser("presets", help="List legacy model presets accepted by the CLI")

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
            mcp=args.mcp,
            skills_dir=args.skills_dir,
            extra=args.extra,
        )
    elif args.command == "presets":
        print(f"{'preset':<14} {'alias':<38} {'prefill_step':<14} max_tokens")
        print("-" * 74)
        for name, preset in PRESETS.items():
            print(f"{name:<14} {preset.alias:<38} {preset.prefill_step_size:<14} {preset.max_tokens}")
    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()
