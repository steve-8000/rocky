#!/bin/sh
# Launch the unified Rocky server (Paseo daemon + Rocky WebUI + AionUi WebUI)
# as ONE Node process. Node >=23 strips TypeScript types natively, so no
# loader is needed; all runtime deps resolve from vendor trees and repo root.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PASEO_HOME="${ROCKY_HOME:-$HOME/.rocky}"
export PASEO_NODE_ENV="${PASEO_NODE_ENV:-production}"

if [ ! -d "$ROOT/vendor/paseo/node_modules" ]; then
  echo "error: vendor/paseo dependencies not installed. Run: npm run setup" >&2
  exit 1
fi

exec node "$ROOT/server/rockyd.ts" "$@"
