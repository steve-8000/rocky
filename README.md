# Rocky

amaze (agent runtime) + Paseo (session daemon / workspaces / models / attachments) + AionUi-style orchestrator mode, packaged as one server with a remote WebUI and a macOS desktop app.

See [DESIGN.md](DESIGN.md) for architecture and decisions.

## Quickstart

```bash
npm run setup            # checks amaze, installs vendored deps, writes ~/.rocky/config.json
npm run daemon:start     # Rocky daemon on 0.0.0.0:7767 (home: ~/.rocky)
npm run daemon:status
```

Set a password before exposing port 7767 beyond localhost:

```bash
cd vendor/paseo && npm run cli -- daemon set-password
```

## Remote WebUI

```bash
npm run build:webui      # Expo web export → vendor/paseo/packages/app/dist
npm run serve:webui      # serves it on 0.0.0.0:7780
```

Open `http://<host>:7780`, add a host with endpoint `<host>:7767` and the daemon password. All agent traffic goes browser → daemon WebSocket directly; the static server only ships the SPA. If the daemon and WebUI live on different origins, add the WebUI origin to `daemon.cors.allowedOrigins` and the host to `daemon.hostnames` in `~/.rocky/config.json` (the template covers localhost:7780).

## Desktop app (DMG)

```bash
npm run build:dmg
# → vendor/paseo/packages/desktop/release/Rocky-<version>-arm64.dmg
```

The app is ad-hoc signed (no notarization — no Developer ID on this machine). On another Mac you must clear quarantine once: `xattr -dr com.apple.quarantine /Applications/Rocky.app`. The bundle manages its own daemon (`~/.rocky`, app id `one.clab.rocky`) and ships a `rocky` CLI shim (Settings → Integrations installs it to `~/.local/bin/rocky`).

## amaze provider

`~/.rocky/config.json` registers amaze as an ACP provider:

```json
"agents": { "providers": { "amaze": { "extends": "acp", "label": "Amaze", "command": ["amaze", "acp"] } } }
```

Rocky uses whatever `amaze` is on PATH — upgrade amaze independently.

```bash
cd vendor/paseo && npm run cli -- agent run --provider amaze --cwd <repo> "task..."
```

## Orchestrator mode

`skills/rocky-orchestrate/SKILL.md` (also bundled into the app) runs AionUi Team-Mode-style Leader/Teammate orchestration on daemon primitives: parallel `create_agent` Teammates (worktree-isolated by default), a chat-room mailbox, a `TEAM_BOARD.md` task board, per-agent permission queues, and silent-agent escalation. Invoke `/rocky-orchestrate <goal>` from any agent with Paseo MCP tools injected (`daemon.mcp.injectIntoAgents` is on in the template config).

## Upstream sync

`vendor/paseo` is a git worktree of `~/roy/paseo` on branch `rocky` (branding + defaults as commits). To pull upstream:

```bash
cd vendor/paseo && git fetch origin && git merge origin/main
```
