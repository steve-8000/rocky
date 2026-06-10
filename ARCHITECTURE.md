# Rocky — Three-System Integrated Architecture

Rocky integrates **amaze**, **Paseo**, and **AionUi** into one self-contained
project. Everything needed to build and run lives inside this repository — no
sibling checkouts, no PATH-installed agent binaries. Paseo and AionUi run as
**one unified server process (`rockyd`)**; amaze stays a separate CLI runtime
that the server spawns per agent session.

```
┌──────────────────────────────── Clients ────────────────────────────────┐
│  Rocky.app (DMG)      Rocky WebUI            AionUi Cowork WebUI        │
│  Electron desktop     (Expo SPA :7780)       (SPA + /api proxy :25808)  │
└──────┬──────────────────────┬─────────────────────────┬─────────────────┘
       │ Paseo WS protocol    │ static                  │ HTTP/WS
┌──────┴──────────────────────┴─────────────────────────┴─────────────────┐
│                     rockyd — ONE Node process (server/rockyd.ts)        │
│                                                                          │
│  ┌─────────────────────────────┐   ┌──────────────────────────────────┐ │
│  │ Paseo daemon (in-process)   │   │ AionUi web-host (in-process)     │ │
│  │ vendor/paseo library call   │   │ vendor/aionui/packages/web-host  │ │
│  │ ws/http 0.0.0.0:7767        │   │ SPA + reverse proxy :25808       │ │
│  │ home ~/.rocky               │   │                                  │ │
│  ├─────────────────────────────┤   │  ┌────────────────────────────┐  │ │
│  │ agent lifecycle, timeline   │   │  │ aioncore (Rust, managed    │  │ │
│  │ workspaces / worktrees      │◄──┼──┤ child process — closed-    │  │ │
│  │ models / providers          │MCP│  │ source prebuilt binary)    │  │ │
│  │ file attachments, terminals │   │  │ Team Mode: Leader/Teammate │  │ │
│  │ schedules, permissions      │   │  │ task board, async mailbox  │  │ │
│  │ MCP server, E2E relay       │   │  └────────────────────────────┘  │ │
│  └──────────┬──────────────────┘   └───────────────┬──────────────────┘ │
│             │ + Rocky WebUI static server :7780    │                    │
└─────────────┼───────────────────────────────────────┼────────────────────┘
              │ ACP (stdio, per agent session)        │ ACP (stdio)
       ┌──────▼────────────────────────────────────────▼──────┐
       │              amaze (vendor/amaze, separate CLI)      │
       │   `bun vendor/amaze/packages/coding-agent/src/cli.ts │
       │    acp` — scout-and-orchestrate runtime, Mission     │
       │   Control, bounded subagents, plan mode              │
       └──────────────────────────────────────────────────────┘
```

## Why one process — and the one exception

`rockyd` (`server/rockyd.ts`) hosts everything Node-side in a single runtime:

- **Paseo daemon** is consumed as a library (`createPaseoDaemon` from the built
  `@getpaseo/server` dist) instead of being supervised as a subprocess.
- **AionUi web-host** (`startWebHost`) runs in the same process: static SPA,
  reverse proxy, auth seeding.
- **Rocky WebUI** is a static file server for the Expo web export.

One startup command, one log stream, one lifecycle (SIGINT/SIGTERM stops all
layers in order).

The one exception is **aioncore**, AionUi's Rust backend. Its source is not in
the AionUi repository — only a prebuilt binary ships. It cannot be linked into
a Node process, so web-host manages it as a child with health checks and crash
restart. amaze likewise stays a separate CLI by design (per-session isolation:
each agent gets its own process, cwd, and lifetime).

## What each system contributes

| Layer | Source | Contribution |
| --- | --- | --- |
| Agent runtime | `vendor/amaze` (full source + prebuilt darwin-arm64 native addon) | The amaze CLI, unchanged. ACP over stdio: default/plan modes, model selection, content-block file attachments. |
| Control plane | `vendor/paseo` (full source, Rocky branding commits) | Session daemon: agent lifecycle + append-only timeline, workspace/worktree registry, model/provider catalog, file attachments, terminals, schedules, permissions, MCP server, E2E relay, Expo web client, Electron DMG. |
| Orchestrator + Cowork UI | `vendor/aionui` (full source + bundled aioncore binary + built renderer) | Team Mode orchestration (Leader/Teammates, shared task board, async mailbox, per-agent permission dialogs), Cowork WebUI, 21 assistants, skills, MCP unified management. |

## Integration contracts

Configuration-level only; each vendored tree stays mergeable with upstream.

- **C1 — amaze ⇄ Paseo:** `~/.rocky/config.json` registers vendored amaze as an
  ACP provider (`command: ["bun", "<root>/vendor/amaze/.../cli.ts", "acp"]`).
  `setup.sh` substitutes the absolute path.
- **C2 — amaze ⇄ AionUi:** `rockyd` registers vendored amaze as a custom ACP
  agent against aioncore's HTTP API on every boot (idempotent create/update).
- **C3 — AionUi ⇄ Paseo:** the daemon's MCP server (agents/terminals/worktrees/
  schedules/permissions) can be added once in AionUi's MCP unified management
  via the bundled stdio bridge
  (`vendor/paseo/packages/server/dist/scripts/mcp-stdio-socket-bridge-cli.mjs`)
  and syncs to all AionUi agents — an AionUi Team Mode Leader can then drive
  daemon-managed agents in Paseo worktrees.

## Two orchestration paths, one substrate

| | AionUi Team Mode (UI) | `rocky-orchestrate` skill (headless) |
| --- | --- | --- |
| Leader | AionUi Leader agent (any backend incl. amaze) | Any daemon agent with MCP tools |
| Teammates | AionUi ACP sessions and/or daemon agents via C3 | Daemon agents (worktree-isolated) |
| Task board | AionUi team board UI | `TEAM_BOARD.md` in workspace |
| Mailbox | AionUi async mailbox | Daemon chat room |
| Permissions | Per-agent dialogs + badges | Daemon permission queue |

## Ports & homes

| Service | Port | State |
| --- | --- | --- |
| Paseo daemon (in rockyd) | 7767 | `~/.rocky` |
| Rocky WebUI (in rockyd) | 7780 | — static |
| AionUi WebUI (in rockyd) | 25808 | `~/.rocky/aionui` |
| aioncore (child of rockyd) | ephemeral, localhost | `~/.rocky/aionui` |

All state lives under one home (`~/.rocky`). Nothing collides with stock
Paseo (6767/`~/.paseo`) or stock AionUi (`~/.aionui`) on the same machine.

## Self-containment policy

- `vendor/{amaze,paseo,aionui}` are full tracked source trees (AionUi README
  media stripped; `node_modules`/build outputs rebuilt locally by `setup.sh`).
- Committed binaries, unavoidable by provenance:
  `vendor/aionui/resources/bundled-aioncore/darwin-arm64/aioncore` (closed
  source) and `vendor/amaze/packages/natives/native/amaze_natives.darwin-arm64.node`
  (skips a Rust nightly toolchain requirement; rebuildable via
  `bun run build:native` inside vendor/amaze).
- `vendor/aionui/out/renderer` (built SPA) is committed so AionUi's WebUI works
  without an electron-vite build.
- The only network access setup needs is the npm/bun package registry.

## Repository layout

```
rocky/
├── ARCHITECTURE.md            ← this file
├── DESIGN.md                  ← decision record
├── README.md                  ← operations
├── package.json               ← npm run setup / start / cli / build:*
├── server/rockyd.ts           ← THE unified server entry
├── config/rocky.config.json   ← ~/.rocky/config.json template
├── skills/rocky-orchestrate/  ← headless Leader/Teammate skill
├── scripts/
│   ├── setup.sh               ← all-vendor install + web-host compile + config
│   ├── rockyd.sh              ← launcher (node, native TS)
│   └── brand/make-icons.py    ← Rocky icon set generator
└── vendor/
    ├── amaze/                 ← agent runtime (separate CLI)
    ├── paseo/                 ← control plane (in rockyd)
    └── aionui/                ← orchestrator + Cowork UI (in rockyd)
```
