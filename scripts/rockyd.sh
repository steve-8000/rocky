#!/bin/sh
# Launch the unified Rocky server (daemon + web UI)
# as ONE Node process. Node >=23 strips TypeScript types natively, so no
# loader is needed; all runtime deps resolve from vendor trees and repo root.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ROCKY_HOME="${ROCKY_HOME:-$HOME/.rocky}"
export ROCKY_NODE_ENV="${ROCKY_NODE_ENV:-production}"

if [ ! -d "$ROOT/core/node_modules" ]; then
  echo "error: core dependencies not installed. Run: npm run setup" >&2
  exit 1
fi

exec node "$ROOT/server/rockyd.ts" "$@"
