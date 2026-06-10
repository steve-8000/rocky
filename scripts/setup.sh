#!/bin/sh
# Rocky setup: install vendored deps, write ~/.rocky/config.json, check amaze.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROCKY_HOME="${ROCKY_HOME:-$HOME/.rocky}"

echo "==> Checking amaze CLI"
if ! command -v amaze >/dev/null 2>&1; then
  echo "error: amaze not found on PATH. Install it first (see ~/roy/amaze/amaze/README.md)." >&2
  exit 1
fi
amaze --version

echo "==> Installing vendored Paseo dependencies"
cd "$ROOT/vendor/paseo"
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi

echo "==> Writing $ROCKY_HOME/config.json (kept if it already exists)"
mkdir -p "$ROCKY_HOME"
chmod 700 "$ROCKY_HOME"
if [ ! -f "$ROCKY_HOME/config.json" ]; then
  cp "$ROOT/config/rocky.config.json" "$ROCKY_HOME/config.json"
  echo "    created from template (listen 0.0.0.0:7767, amaze ACP provider)"
else
  echo "    exists — left untouched. Compare with config/rocky.config.json if needed."
fi

echo "==> Done. Next steps:"
echo "    npm run dev          # daemon + Expo dev (from vendor/paseo)"
echo "    npm run build:webui  # static remote WebUI"
echo "    npm run build:dmg    # Rocky.app DMG"
echo "    Set a daemon password before exposing 7767: rocky daemon set-password"
