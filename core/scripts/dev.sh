#!/bin/bash
set -e

# Ensure node_modules/.bin is in PATH (for when script runs directly)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"
configure_dev_rocky_home

# Share speech models with the main install to avoid duplicate downloads
if [ -z "${ROCKY_LOCAL_MODELS_DIR}" ]; then
  export ROCKY_LOCAL_MODELS_DIR="$HOME/.rocky/models/local-speech"
  mkdir -p "$ROCKY_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Rocky Dev"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${ROCKY_HOME}"
echo "  Models:  ${ROCKY_LOCAL_MODELS_DIR}"
echo "══════════════════════════════════════════════════════"

npm run build:server
npm run build --workspace=@getrocky/expo-two-way-audio

# Configure the daemon for the Portless app origin and let the app bootstrap
# through the daemon's Portless URL instead of a fixed localhost port.
APP_ORIGIN="$(portless get app)"
DAEMON_ENDPOINT="$(portless get daemon | sed -E 's#^https?://##')"
# Allow any origin in dev so Electron on random ports and Portless URLs all work.
# SECURITY: wildcard CORS is unsafe in production — only acceptable here because
# the daemon binds to localhost and this script is never used for production.
export ROCKY_CORS_ORIGINS="*"

# Run both with concurrently
# BROWSER=none prevents auto-opening browser
# EXPO_PUBLIC_LOCAL_DAEMON configures the app to auto-connect to this daemon
concurrently \
  --names "daemon,metro" \
  --prefix-colors "cyan,magenta" \
  "portless run --name daemon sh -c 'ROCKY_SKIP_DEV_SERVER_BUILD=1 ROCKY_LISTEN=0.0.0.0:\$PORT exec ./scripts/dev-daemon.sh'" \
  "BROWSER=none APP_VARIANT=development EXPO_PUBLIC_LOCAL_DAEMON='${DAEMON_ENDPOINT}' portless run --name app npm run start:expo --workspace=@getrocky/app"
