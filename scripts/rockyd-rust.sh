#!/bin/sh
# ALTERNATE, opt-in entrypoint: launch the compiled Rust `rockyd` daemon in the
# foreground. This is NOT the default launch path (scripts/rockyd.sh is) and is
# NOT referenced by any launchd job. Use it for manual cutover testing only.
#
# Mirrors scripts/rockyd.sh's environment setup (ROCKY_HOME / ROCKY_WEB_UI_DIR)
# so the Rust binary serves the same WebUI bundle, then execs
# `rockyd --foreground`.
set -eu

unset CDPATH
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)

export ROCKY_HOME="${ROCKY_HOME:-$HOME/.rocky}"
export ROCKY_NODE_ENV="${ROCKY_NODE_ENV:-production}"
export ROCKY_STATIC_DIR="${ROCKY_STATIC_DIR:-$ROCKY_HOME/public}"
export ROCKY_WEB_UI_DIR="${ROCKY_WEB_UI_DIR:-$ROOT/core/packages/app/dist}"
# Repo root used for `__ROCKY_ROOT__` expansion in ACP agent commands.
export ROCKY_ROOT="${ROCKY_ROOT:-$ROOT}"

BIN="$ROOT/rust/target/release/rockyd"

if [ ! -x "$BIN" ]; then
  echo "error: compiled rockyd binary missing at $BIN" >&2
  echo "build it first: (cd $ROOT/rust && cargo build --release -p rockyd)" >&2
  exit 1
fi

# Run in the repo root so the default repo-root resolution (process cwd) is
# correct even when ROCKY_ROOT is unset.
cd "$ROOT"
exec "$BIN" --foreground "$@"
