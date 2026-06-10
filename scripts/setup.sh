#!/bin/sh
# Rocky setup — fully self-contained: installs deps for all vendored trees,
# compiles the AionUi web-host package, and writes ~/.rocky/config.json with
# the vendored amaze registered as an ACP provider.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROCKY_HOME="${ROCKY_HOME:-$HOME/.rocky}"

command -v node >/dev/null 2>&1 || { echo "error: node (>=23) required" >&2; exit 1; }
command -v bun  >/dev/null 2>&1 || { echo "error: bun (>=1.3) required — https://bun.sh" >&2; exit 1; }

echo "==> Installing root deps (serve-handler for AionUi web-host)"
cd "$ROOT" && npm install --no-audit --no-fund

echo "==> Installing vendored Paseo dependencies"
cd "$ROOT/vendor/paseo"
[ -d node_modules ] || npm ci --no-audit --no-fund

echo "==> Building Paseo server dist (rockyd imports the built library)"
[ -f packages/server/dist/server/server/exports.js ] || npm run build:server

echo "==> Installing vendored amaze dependencies"
cd "$ROOT/vendor/amaze" && bun install --no-progress

echo "==> Compiling AionUi web-host"
cd "$ROOT/vendor/aionui/packages/web-host"
"$ROOT/vendor/paseo/node_modules/typescript/bin/tsc" \
  src/index.ts src/types.ts src/static-server.ts src/backend-launcher.ts src/agent-process-registry.ts \
  --outDir dist --module nodenext --target es2022 --moduleResolution nodenext \
  --skipLibCheck --declaration false || true  # type errors from missing @types are fine; emit is what matters
[ -f dist/index.js ] || { echo "error: web-host compile produced no output" >&2; exit 1; }
mkdir -p node_modules
ln -sfn "$ROOT/node_modules/serve-handler" node_modules/serve-handler

echo "==> Writing $ROCKY_HOME/config.json (kept if it already exists)"
mkdir -p "$ROCKY_HOME"; chmod 700 "$ROCKY_HOME"
if [ ! -f "$ROCKY_HOME/config.json" ]; then
  sed "s|__ROCKY_ROOT__|$ROOT|g" "$ROOT/config/rocky.config.json" > "$ROCKY_HOME/config.json"
  echo "    created (daemon 0.0.0.0:7767, vendored amaze ACP provider)"
else
  echo "    exists — left untouched. Template: config/rocky.config.json (__ROCKY_ROOT__ → $ROOT)"
fi

echo "==> Done. Start everything with: npm start"
echo "    Set a daemon password before exposing 7767: npm run cli -- daemon set-password"
