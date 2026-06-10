#!/bin/sh
# Rocky regression contract — deterministic acceptance checks.
# Boots the unified rockyd stack against a throwaway home on offset ports,
# asserts all three layers plus both amaze integrations, then tears down.
# Exit 0 = pass. Any failed check exits non-zero.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PORT_DAEMON="${SMOKE_DAEMON_PORT:-7967}"
PORT_WEBUI="${SMOKE_WEBUI_PORT:-7980}"
PORT_AIONUI="${SMOKE_AIONUI_PORT:-25908}"
LOG=$(mktemp /tmp/rocky-smoke.XXXXXX.log)
HOME_DIR=$(mktemp -d)/rocky-smoke-home
WORK_DIR=$(mktemp -d)
PID=""

fail() { echo "FAIL: $1" >&2; [ -f "$LOG" ] && tail -20 "$LOG" >&2; exit 1; }

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  pkill -f "bundled-aioncore.*rocky-smoke-home" 2>/dev/null || true
  sleep 2
  rm -rf "$(dirname "$HOME_DIR")" "$WORK_DIR" "$LOG"
}
trap cleanup EXIT INT TERM

# ── preconditions ──────────────────────────────────────────────────────────
[ -f "$ROOT/vendor/paseo/packages/server/dist/server/server/exports.js" ] \
  || fail "paseo dist missing — run npm run setup"
[ -f "$ROOT/vendor/aionui/packages/web-host/dist/index.js" ] \
  || fail "web-host dist missing — run npm run setup"
[ -d "$ROOT/vendor/amaze/node_modules" ] \
  || fail "amaze deps missing — run npm run setup"
for p in "$PORT_DAEMON" "$PORT_WEBUI" "$PORT_AIONUI"; do
  lsof -ti ":$p" >/dev/null 2>&1 && fail "port $p already in use"
done

# ── check 1: vendored amaze CLI launches standalone ────────────────────────
( cd "$ROOT/vendor/amaze" && timeout 20 bun packages/coding-agent/src/cli.ts --version ) \
  | grep -q "amaze/" || fail "vendored amaze CLI does not run"
echo "ok: vendored amaze CLI"

# ── boot unified stack ─────────────────────────────────────────────────────
mkdir -p "$HOME_DIR"; chmod 700 "$HOME_DIR"
sed "s|__ROCKY_ROOT__|$ROOT|g; s|0\.0\.0\.0:7767|127.0.0.1:$PORT_DAEMON|" \
  "$ROOT/config/rocky.config.json" > "$HOME_DIR/config.json"
ROCKY_HOME="$HOME_DIR" ROCKY_WEBUI_PORT="$PORT_WEBUI" ROCKY_AIONUI_PORT="$PORT_AIONUI" \
  ROCKY_ALLOW_REMOTE=0 sh "$ROOT/scripts/rockyd.sh" > "$LOG" 2>&1 &
PID=$!

i=0
until grep -aq "all layers up" "$LOG" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && fail "rockyd did not become ready in 60s"
  kill -0 "$PID" 2>/dev/null || fail "rockyd exited during startup"
  sleep 1
done
echo "ok: rockyd single process up"

# ── check 2-4: all three layers answer ─────────────────────────────────────
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_DAEMON/api/health?direct=1")" = 200 ] \
  || fail "paseo daemon health != 200"
echo "ok: paseo daemon :$PORT_DAEMON"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_WEBUI/")" = 200 ] \
  || fail "rocky webui != 200"
echo "ok: rocky webui :$PORT_WEBUI"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_AIONUI/")" = 200 ] \
  || fail "aionui webui != 200"
echo "ok: aionui webui :$PORT_AIONUI"

# ── check 5: amaze registered with AionUi (C2) ─────────────────────────────
grep -aq "amaze registered with AionUi" "$LOG" \
  || fail "vendored amaze was not registered with AionUi backend"
echo "ok: amaze ⇄ aionui registration (C2)"

# ── check 6: daemon E2E with vendored amaze (C1) — needs provider auth ─────
if [ "${SMOKE_SKIP_AGENT_RUN:-0}" = "1" ]; then
  echo "skip: daemon amaze agent run (SMOKE_SKIP_AGENT_RUN=1)"
else
  ( cd "$ROOT/vendor/paseo" && PASEO_HOME="$HOME_DIR" PASEO_LISTEN="127.0.0.1:$PORT_DAEMON" \
      timeout 180 npm run cli --silent -- agent run --provider amaze --cwd "$WORK_DIR" \
      "Create a file named smoke.txt containing exactly 'rocky smoke' and stop." ) > /dev/null 2>&1 \
    || fail "daemon amaze agent run failed"
  [ "$(cat "$WORK_DIR/smoke.txt" 2>/dev/null)" = "rocky smoke" ] \
    || fail "agent did not produce expected smoke.txt"
  echo "ok: daemon ⇄ amaze E2E agent run (C1)"
fi

echo "PASS: all regression checks green"
