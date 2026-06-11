#!/bin/sh
# Production cutover runbook: switch the canonical launchd daemon from the
# TypeScript supervisor to the Rust `rockyd` binary, with a backup + rollback.
#
# THIS SCRIPT IS NOT AUTO-RUN. It is the documented, reviewable procedure for an
# operator to execute deliberately, matching the cutover-safety checklist in
# core/docs/rust-rebuild/05-migration-and-verification.md.
#
# PRECONDITIONS (the operator MUST confirm before running):
#   1. `cd rust && cargo build --release -p rockyd` succeeds.
#   2. `scripts/rockyd-rust.sh` serves the WebUI + /ws + /mcp/agents on a test
#      port against a COPY of $ROCKY_HOME (verified parity, no regressions).
#   3. No active/running agents you care about, OR you accept they will be
#      interrupted (the daemon restart stops in-flight provider turns).
#   4. The remaining WS session RPC gap (see rust/STATUS.md) is acceptable for
#      your workflow, or those RPCs have been implemented.
#
# This script intentionally STOPS with a confirmation gate. It does not flip
# anything without `CONFIRM=yes`.
set -eu

unset CDPATH
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
ROCKY_HOME="${ROCKY_HOME:-$HOME/.rocky}"
LABEL="one.clab.rocky"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$ROCKY_HOME/.cutover-backups/$STAMP"

echo "Rocky → Rust cutover runbook"
echo "  ROCKY_HOME : $ROCKY_HOME"
echo "  launchd    : $LABEL ($PLIST)"
echo "  backup dir : $BACKUP_DIR"
echo

if [ "${CONFIRM:-no}" != "yes" ]; then
  cat <<'GUARD'
Refusing to proceed without CONFIRM=yes.

This will:
  1. Back up $ROCKY_HOME (config + registries + missions + agents metadata).
  2. Stop the current canonical daemon.
  3. Repoint the launchd job to scripts/rockyd-rust.sh (Rust binary).
  4. Start it and run a health/UI/API/WS check.

Rollback (if the check fails) restores the previous launchd program and
restarts the TypeScript daemon; it never modifies stored agent records.

Re-run with:  CONFIRM=yes sh scripts/cutover-to-rust.sh
GUARD
  exit 2
fi

# 1. Backup (metadata + state; not logs).
mkdir -p "$BACKUP_DIR"
for item in config.json server-id daemon-keypair.json projects missions chat loops schedules push-tokens.json; do
  [ -e "$ROCKY_HOME/$item" ] && cp -R "$ROCKY_HOME/$item" "$BACKUP_DIR/" || true
done
[ -f "$PLIST" ] && cp "$PLIST" "$BACKUP_DIR/$LABEL.plist.bak" || true
echo "ok: backed up to $BACKUP_DIR"

# 2/3/4 are left as explicit operator steps rather than an automated flip,
# because editing a user LaunchAgent plist program and bootstrapping it is
# environment-specific and irreversible enough to warrant manual review.
cat <<EOF

Backup complete. To finish the cutover manually:

  # build the binary
  ( cd "$ROOT/rust" && cargo build --release -p rockyd )

  # stop the TypeScript daemon
  launchctl bootout "gui/\$(id -u)/$LABEL" 2>/dev/null || true

  # edit $PLIST so its program/arguments exec:
  #     /bin/sh $ROOT/scripts/rockyd-rust.sh
  # then re-bootstrap:
  launchctl bootstrap "gui/\$(id -u)" "$PLIST"
  launchctl kickstart -k "gui/\$(id -u)/$LABEL"

  # verify
  curl -fsS http://127.0.0.1:7767/api/health && echo OK

Rollback: restore $BACKUP_DIR/$LABEL.plist.bak to $PLIST and re-bootstrap.
EOF
