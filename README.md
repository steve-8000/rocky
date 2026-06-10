# Rocky

amaze (agent runtime) + Paseo (server core & UI) + AionUi's Team Mode orchestration, integrated into **one self-contained project: one process, one port, one UI**.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the integration design and [DESIGN.md](DESIGN.md) for the decision record.

## Quickstart

Prerequisites: Node ≥ 23 (native TS), Bun ≥ 1.3, npm registry access.

```bash
npm run setup     # vendor deps, paseo build, webui export, skill link, ~/.rocky/config.json
npm start         # rockyd → http://<host>:7767  (UI + API + WS, single origin)
npm run smoke     # regression contract
```

Set a daemon password before exposing 7767 beyond localhost:

```bash
npm run cli -- daemon set-password
```

Environment knobs: `ROCKY_HOME` (default `~/.rocky`); listen address/port live in `~/.rocky/config.json` (`daemon.listen`).

## amaze

Vendored at `vendor/amaze`, run from source via Bun — never from PATH. Registered as an ACP provider in `~/.rocky/config.json`; each agent session is its own short-lived process.

```bash
npm run cli -- agent run --provider amaze --cwd <repo> "task"
```

## Orchestrator mode (from AionUi Team Mode)

`/rocky-orchestrate` — installed to `~/.agents/skills` by setup, bundled in the desktop app. A Leader agent decomposes the goal, delegates to parallel Teammate agents (worktree-isolated), tracks `TEAM_BOARD.md`, communicates over a daemon chat-room mailbox, and escalates silent agents. Runs on the daemon's MCP tools — works from the UI or any agent session.

## Desktop app (DMG)

```bash
npm run build:dmg   # → vendor/paseo/packages/desktop/release/Rocky-<version>-arm64.dmg
```

Ad-hoc signed (no Developer ID on this machine): on another Mac run `xattr -dr com.apple.quarantine /Applications/Rocky.app` once. The app manages its own daemon (`~/.rocky`, id `one.clab.rocky`) and ships a `rocky` CLI shim.

## Self-containment

`vendor/{amaze,paseo}` are full source trees committed here. One committed binary: the amaze darwin-arm64 native addon (rebuildable with Rust nightly via `bun run build:native` in vendor/amaze). AionUi is integrated as re-implemented behavior, not vendored code — see ARCHITECTURE.md for the mapping.
