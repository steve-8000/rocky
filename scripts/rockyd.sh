#!/bin/sh
# Launch the canonical Rocky daemon path: supervisor + worker.
set -eu

unset CDPATH
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
CORE="$ROOT/core"
export ROCKY_HOME="${ROCKY_HOME:-$HOME/.rocky}"
export ROCKY_NODE_ENV="${ROCKY_NODE_ENV:-production}"
export ROCKY_STATIC_DIR="${ROCKY_STATIC_DIR:-$ROCKY_HOME/public}"
export ROCKY_WEB_UI_DIR="${ROCKY_WEB_UI_DIR:-$ROOT/core/packages/app/dist}"

if [ ! -d "$CORE/node_modules" ]; then
  echo "error: core dependencies not installed. Run: npm run setup" >&2
  exit 1
fi

if [ ! -f "$ROCKY_WEB_UI_DIR/index.html" ]; then
  echo "error: Rocky WebUI bundle missing at $ROCKY_WEB_UI_DIR. Run: npm run build:webui" >&2
  exit 1
fi

DIST_ENTRY="$CORE/packages/server/dist/scripts/supervisor-entrypoint.js"
SRC_ENTRY="$CORE/packages/server/scripts/supervisor-entrypoint.ts"

if [ -f "$DIST_ENTRY" ]; then
  exec node "$DIST_ENTRY" "$@"
fi

cd "$CORE"
exec node --import tsx "$SRC_ENTRY" "$@"
