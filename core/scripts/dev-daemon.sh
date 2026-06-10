#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"
configure_dev_rocky_home

if [ -z "${ROCKY_LOCAL_MODELS_DIR}" ]; then
  export ROCKY_LOCAL_MODELS_DIR="$HOME/.rocky/models/local-speech"
  mkdir -p "$ROCKY_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Rocky Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${ROCKY_HOME}"
echo "  Models:  ${ROCKY_LOCAL_MODELS_DIR}"
echo "══════════════════════════════════════════════════════"

export ROCKY_CORS_ORIGINS="${ROCKY_CORS_ORIGINS:-*}"
export ROCKY_NODE_INSPECT="${ROCKY_NODE_INSPECT:---inspect=0}"

if [ "${ROCKY_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec npm run dev:server
