#!/bin/sh
# Rocky setup — fully self-contained: installs deps for both vendored trees,
# builds the Paseo server library, installs the orchestrator skill, and writes
# ~/.rocky/config.json with the vendored amaze registered as an ACP provider.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROCKY_HOME="${ROCKY_HOME:-$HOME/.rocky}"

command -v node >/dev/null 2>&1 || { echo "error: node (>=23) required" >&2; exit 1; }
command -v bun  >/dev/null 2>&1 || { echo "error: bun (>=1.3) required — https://bun.sh" >&2; exit 1; }

echo "==> Installing vendored Paseo dependencies"
cd "$ROOT/vendor/paseo"
[ -d node_modules ] || npm ci --no-audit --no-fund

echo "==> Building Paseo server dist (rockyd imports the built library)"
[ -f packages/server/dist/server/server/exports.js ] || npm run build:server

echo "==> Installing vendored amaze dependencies"
cd "$ROOT/vendor/amaze" && bun install --no-progress

echo "==> Installing rocky-orchestrate skill for agents (~/.agents/skills)"
mkdir -p "$HOME/.agents/skills"
ln -sfn "$ROOT/skills/rocky-orchestrate" "$HOME/.agents/skills/rocky-orchestrate"

echo "==> Writing $ROCKY_HOME/config.json (kept if it already exists)"
mkdir -p "$ROCKY_HOME"; chmod 700 "$ROCKY_HOME"
if [ ! -f "$ROCKY_HOME/config.json" ]; then
  sed "s|__ROCKY_ROOT__|$ROOT|g" "$ROOT/config/rocky.config.json" > "$ROCKY_HOME/config.json"
  echo "    created (daemon 0.0.0.0:7767, vendored amaze ACP provider)"
else
  echo "    exists — left untouched. Template: config/rocky.config.json (__ROCKY_ROOT__ → $ROOT)"
fi

if [ ! -f "$ROOT/vendor/paseo/packages/app/dist/index.html" ]; then
  echo "==> Building Rocky WebUI (Expo web export)"
  cd "$ROOT/vendor/paseo/packages/app" && npm run build:web
fi

echo "==> Done. Start with: npm start  →  http://<host>:7767 (UI + API + WS, one port)"
echo "    Set a daemon password before exposing 7767: npm run cli -- daemon set-password"
