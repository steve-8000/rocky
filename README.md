# Rocky

amaze (agent runtime) + Paseo (session daemon) + AionUi (Team Mode orchestrator & Cowork UI) integrated into **one self-contained project**: a single server process, two remote WebUIs, and a macOS desktop app.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the integration design and [DESIGN.md](DESIGN.md) for the decision record.

## Quickstart

Prerequisites: Node ≥ 23 (native TS), Bun ≥ 1.3, network access to the npm registry only.

```bash
npm run setup     # installs all vendored deps, builds paseo dist + web-host, writes ~/.rocky/config.json
npm start         # rockyd: Paseo daemon :7767 + Rocky WebUI :7780 + AionUi WebUI :25808 — one process
```

`npm start` prints all endpoints plus the AionUi initial admin credentials on first run.

Set a daemon password before exposing 7767 beyond localhost:

```bash
npm run cli -- daemon set-password
```

## What runs where

| Service | Port | Notes |
| --- | --- | --- |
| Paseo daemon | 7767 | WS protocol; agents, workspaces, worktrees, models, attachments, MCP |
| Rocky WebUI | 7780 | Expo SPA — add host `<host>:7767` + daemon password in the UI |
| AionUi WebUI | 25808 | Cowork + Team Mode UI; login with printed admin credentials |
| aioncore | localhost-only | AionUi Rust backend, managed child of rockyd |

Environment knobs: `ROCKY_HOME` (default `~/.rocky`), `ROCKY_WEBUI_PORT`, `ROCKY_AIONUI_PORT`, `ROCKY_ALLOW_REMOTE=0` for localhost-only.

## amaze

Vendored at `vendor/amaze`, run from source via Bun — never from PATH:

- **In Paseo:** registered as ACP provider in `~/.rocky/config.json`. Test: `npm run cli -- agent run --provider amaze --cwd <repo> "task"`.
- **In AionUi:** auto-registered as custom ACP agent on every rockyd boot — appears in Cowork agent list and as a Team Mode backend.

## Orchestrator mode

Two paths over the same daemon substrate:

- **AionUi Team Mode** (UI): create a team in the AionUi WebUI; Leader delegates to parallel Teammates with task board, mailbox, and per-agent permissions. Add the daemon's MCP server in AionUi MCP settings (bridge: `vendor/paseo/packages/server/dist/scripts/mcp-stdio-socket-bridge-cli.mjs`) to let the Leader drive daemon-managed agents in worktrees.
- **`/rocky-orchestrate`** (headless skill, `skills/rocky-orchestrate/`, also bundled in the desktop app): same Leader/Teammate protocol on daemon MCP tools.

## Rocky WebUI build & desktop app

```bash
npm run build:webui   # Expo web export → vendor/paseo/packages/app/dist (needed once before npm start)
npm run build:dmg     # → vendor/paseo/packages/desktop/release/Rocky-<version>-arm64.dmg
```

The DMG is ad-hoc signed (no Developer ID on this machine): on another Mac run `xattr -dr com.apple.quarantine /Applications/Rocky.app` once. The app manages its own daemon (`~/.rocky`, id `one.clab.rocky`) and ships a `rocky` CLI shim.

## Self-containment

`vendor/{amaze,paseo,aionui}` are full source trees committed here. Committed binaries (unavoidable): aioncore (closed-source Rust backend) and the amaze darwin-arm64 native addon (rebuildable with Rust nightly via `bun run build:native` in vendor/amaze). AionUi's built renderer is committed so its WebUI needs no electron-vite build.
