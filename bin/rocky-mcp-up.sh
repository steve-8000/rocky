#!/usr/bin/env bash
# rocky-mcp-up.sh — ensure the rocky-mcp container is up and pin its CURRENT IP into amaze's .mcp.json.
#
# Why this exists: Apple `container` 1.0.0 (macOS) cannot publish a stable host port
# (`-p 127.0.0.1:7777` resets connections) and cannot auto-register a DNS name
# (`rocky-mcp.internal` -> NXDOMAIN; no `dns default`/`property set` in this build).
# The only working endpoint is the container's vmnet IP (192.168.64.x), which is
# STABLE while the container keeps running but is re-assigned on each (re)start.
# So: run this once now, and again only after a restart of the container / apiserver.
set -euo pipefail

NAME="${ROCKY_MCP_NAME:-rocky-mcp}"
IMAGE="${ROCKY_MCP_IMAGE:-rocky-mcp:full}"
PORT="${ROCKY_MCP_PORT:-7777}"
TOKEN="${ROCKY_API_KEY:-rocky-secret}"
MCP_JSON="${ROCKY_MCP_JSON:-$HOME/amaze_s3/amaze/.mcp.json}"
SERVER_KEY="${ROCKY_MCP_SERVER_KEY:-rocky-skills}"

log() { printf '%s\n' "$*" >&2; }

# 0) Ensure the container apiserver is alive. launchd starts it at login (RunAtLoad),
#    but it can lag behind our agent, so wait/kick it before touching containers.
for _ in $(seq 1 60); do
  container system status >/dev/null 2>&1 && break
  container system start >/dev/null 2>&1 || true
  sleep 2
done

# 1) Ensure the container is running.
if container inspect "$NAME" >/dev/null 2>&1; then
  st="$(container inspect "$NAME" 2>/dev/null | jq -r '.[0].status.state // "unknown"')"
  if [ "$st" = "running" ]; then
    log "container '$NAME' already running"
  else
    log "starting existing container '$NAME' (state=$st)..."
    container start "$NAME" >/dev/null
  fi
else
  log "creating container '$NAME' from $IMAGE..."
  container run -d --name "$NAME" -e "ROCKY_API_KEY=$TOKEN" "$IMAGE" >/dev/null
fi

# 2) Resolve the current container IP (retry while the network comes up).
ip=""
for _ in $(seq 1 30); do
  ip="$(container inspect "$NAME" 2>/dev/null | jq -r '.[0].status.networks[0].ipv4Address // empty' | cut -d/ -f1)"
  [ -n "$ip" ] && break
  sleep 1
done
[ -n "$ip" ] || { log "ERROR: could not resolve IPv4 for '$NAME'"; exit 1; }
url="http://$ip:$PORT/mcp"
log "container IP: $ip  ->  $url"

# 3) Wait for the MCP endpoint to answer the initialize handshake.
ready=0
for _ in $(seq 1 60); do
  resp="$(curl -s --max-time 5 -X POST "$url" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rocky-mcp-up","version":"1"}}}' 2>/dev/null || true)"
  case "$resp" in
    *'"serverInfo"'*|*'"result"'*) ready=1; break;;
  esac
  sleep 2
done
[ "$ready" = 1 ] || { log "ERROR: MCP endpoint at $url did not become ready in time"; exit 1; }
log "MCP endpoint ready."

# 4) Pin the URL into .mcp.json (create the file if it does not exist yet).
if [ -f "$MCP_JSON" ]; then
  tmp="$(mktemp)"
  jq --arg key "$SERVER_KEY" --arg url "$url" \
    '.mcpServers[$key].url = $url' "$MCP_JSON" > "$tmp" && mv "$tmp" "$MCP_JSON"
  log "updated $MCP_JSON  ($SERVER_KEY -> $url)"
else
  mkdir -p "$(dirname "$MCP_JSON")"
  cat > "$MCP_JSON" <<EOF
{
	"\$schema": "https://raw.githubusercontent.com/can1357/amaze-agent/main/packages/coding-agent/src/config/mcp-schema.json",
	"mcpServers": {
		"$SERVER_KEY": {
			"type": "http",
			"url": "$url",
			"headers": {
				"Authorization": "Bearer $TOKEN"
			}
		}
	}
}
EOF
  log "created $MCP_JSON  ($SERVER_KEY -> $url)"
fi

printf '%s\n' "$url"
