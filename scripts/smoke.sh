#!/bin/sh
# Rocky regression contract — deterministic acceptance checks.
# Boots rockyd (ONE process, ONE port) against a throwaway home, asserts the
# single-origin UI+API+WS surface and the amaze integration, then tears down.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PORT="${SMOKE_PORT:-7967}"
LOG=$(mktemp /tmp/rocky-smoke.XXXXXX.log)
HOME_DIR=$(mktemp -d)/rocky-smoke-home
WORK_DIR=$(mktemp -d)
PID=""

fail() { echo "FAIL: $1" >&2; [ -f "$LOG" ] && tail -20 "$LOG" >&2; exit 1; }

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  sleep 2
  rm -rf "$(dirname "$HOME_DIR")" "$WORK_DIR" "$LOG"
}
trap cleanup EXIT INT TERM

# ── preconditions ──────────────────────────────────────────────────────────
[ -f "$ROOT/vendor/paseo/packages/server/dist/server/server/exports.js" ] \
  || fail "paseo dist missing — run npm run setup"
[ -f "$ROOT/vendor/paseo/packages/app/dist/index.html" ] \
  || fail "webui bundle missing — run npm run setup"
[ -d "$ROOT/vendor/amaze/node_modules" ] \
  || fail "amaze deps missing — run npm run setup"
lsof -ti ":$PORT" >/dev/null 2>&1 && fail "port $PORT already in use"

# ── check 1: vendored amaze CLI launches standalone ────────────────────────
( cd "$ROOT/vendor/amaze" && timeout 20 bun packages/coding-agent/src/cli.ts --version ) \
  | grep -q "amaze/" || fail "vendored amaze CLI does not run"
echo "ok: vendored amaze CLI"

# ── boot single-process single-port stack ──────────────────────────────────
mkdir -p "$HOME_DIR"; chmod 700 "$HOME_DIR"
sed "s|__ROCKY_ROOT__|$ROOT|g; s|0\.0\.0\.0:7767|127.0.0.1:$PORT|" \
  "$ROOT/config/rocky.config.json" > "$HOME_DIR/config.json"
ROCKY_HOME="$HOME_DIR" sh "$ROOT/scripts/rockyd.sh" > "$LOG" 2>&1 &
PID=$!

i=0
until grep -aq "rockyd\] up" "$LOG" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && fail "rockyd did not become ready in 60s"
  kill -0 "$PID" 2>/dev/null || fail "rockyd exited during startup"
  sleep 1
done
echo "ok: rockyd single process up"

# ── checks 2-4: one origin serves UI, SPA routes, and API ──────────────────
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" = 200 ] \
  || fail "UI root != 200"
curl -s "http://127.0.0.1:$PORT/" | grep -q "<title>Rocky" \
  || fail "UI is not Rocky-branded"
echo "ok: Rocky UI at root"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/h/deep/spa/route")" = 200 ] \
  || fail "SPA fallback != 200"
echo "ok: SPA route fallback"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health?direct=1")" = 200 ] \
  || fail "daemon health != 200"
echo "ok: API on same origin"

# ── check 5: daemon E2E with vendored amaze — needs provider auth ──────────
if [ "${SMOKE_SKIP_AGENT_RUN:-0}" = "1" ]; then
  echo "skip: daemon amaze agent run (SMOKE_SKIP_AGENT_RUN=1)"
else
  ( cd "$ROOT/vendor/paseo" && PASEO_HOME="$HOME_DIR" PASEO_LISTEN="127.0.0.1:$PORT" \
      timeout 180 npm run cli --silent -- agent run --provider amaze --cwd "$WORK_DIR" \
      "Create a file named smoke.txt containing exactly 'rocky smoke' and stop." ) > /dev/null 2>&1 \
    || fail "daemon amaze agent run failed"
  [ "$(cat "$WORK_DIR/smoke.txt" 2>/dev/null)" = "rocky smoke" ] \
    || fail "agent did not produce expected smoke.txt"
  echo "ok: daemon ⇄ amaze E2E agent run"
fi

echo "PASS: single-port single-UI regression green"
