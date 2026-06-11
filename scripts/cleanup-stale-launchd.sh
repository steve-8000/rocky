#!/bin/sh
# Detect and disable the known STALE duplicate Rocky LaunchAgent label
# `one.clab.rocky.rockyd`. This label is a leftover duplicate; the canonical
# Rocky job is `one.clab.rocky` and this script NEVER touches it.
#
# Actions (all idempotent, all best-effort):
#   1. bootout the stale label from the current GUI domain (if loaded)
#   2. disable the stale label (so it cannot be re-bootstrapped)
#   3. rename its plist to `<plist>.disabled` (if a live plist is present)
#
# Running this when nothing stale exists is a no-op. This script is provided for
# manual cutover hygiene; it is NOT executed automatically by anything.
set -eu

STALE_LABEL="one.clab.rocky.rockyd"
CANONICAL_LABEL="one.clab.rocky"
LA_DIR="$HOME/Library/LaunchAgents"
PLIST="$LA_DIR/$STALE_LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

did_something=0

# Hard guard: never act on the canonical label, whatever else happens.
if [ "$STALE_LABEL" = "$CANONICAL_LABEL" ]; then
  echo "refusing to operate: stale label equals canonical label" >&2
  exit 1
fi

# 1. bootout from the GUI domain if currently loaded.
if launchctl print "$GUI_DOMAIN/$STALE_LABEL" >/dev/null 2>&1; then
  if launchctl bootout "$GUI_DOMAIN/$STALE_LABEL" >/dev/null 2>&1; then
    echo "booted out $GUI_DOMAIN/$STALE_LABEL"
    did_something=1
  else
    echo "warning: bootout of $GUI_DOMAIN/$STALE_LABEL failed (may already be unloaded)" >&2
  fi
else
  echo "stale label $STALE_LABEL is not loaded in $GUI_DOMAIN (nothing to bootout)"
fi

# 2. disable the stale label so it cannot be bootstrapped again.
if launchctl disable "$GUI_DOMAIN/$STALE_LABEL" >/dev/null 2>&1; then
  echo "disabled $GUI_DOMAIN/$STALE_LABEL"
  did_something=1
else
  echo "warning: disable of $GUI_DOMAIN/$STALE_LABEL failed or already disabled" >&2
fi

# 3. rename a live plist out of the way (preserve, do not delete).
if [ -f "$PLIST" ]; then
  mv "$PLIST" "$PLIST.disabled"
  echo "renamed $PLIST -> $PLIST.disabled"
  did_something=1
elif [ -f "$PLIST.disabled" ]; then
  echo "plist already disabled at $PLIST.disabled (nothing to rename)"
else
  echo "no stale plist found at $PLIST (nothing to rename)"
fi

if [ "$did_something" -eq 0 ]; then
  echo "nothing to do: no stale $STALE_LABEL artifacts present"
fi

echo "canonical job $CANONICAL_LABEL left untouched"
