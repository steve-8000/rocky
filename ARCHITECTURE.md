# Rocky — Three-System Integrated Architecture

Rocky integrates **amaze**, **Paseo**, and **AionUi's orchestrator concept**
into one self-contained project: **one server process, one port, one UI**.

```
┌────────────────────────── Clients ──────────────────────────┐
│   Browser (remote WebUI)        Rocky.app (Electron DMG)    │
│   http://host:7767              managed daemon + same SPA   │
└───────────────┬─────────────────────────┬───────────────────┘
                │  ONE origin: UI + API + WS  (:7767)
┌───────────────┴─────────────────────────┴───────────────────┐
│            rockyd — ONE Node process (server/rockyd.ts)     │
│                                                              │
│  Paseo daemon core (in-process library, vendor/paseo)        │
│   • agent lifecycle + append-only timeline                   │
│   • workspaces / git worktrees                               │
│   • model & provider catalog                                 │
│   • file attachments, terminals, schedules                   │
│   • permissions, MCP server, E2E relay                       │
│   • Rocky WebUI (Expo SPA) served at the daemon root         │
│                                                              │
│  Orchestrator mode (AionUi Team Mode, re-implemented native) │
│   • rocky-orchestrate skill on daemon MCP tools              │
│   • Leader/Teammate, TEAM_BOARD.md, chat-room mailbox,       │
│     worktree isolation, per-agent permission queue           │
└──────────────────────────┬───────────────────────────────────┘
                           │ ACP (stdio, per agent session)
              ┌────────────▼────────────┐
              │  amaze (vendor/amaze)   │   separate CLI by design:
              │  scout-and-orchestrate  │   each agent session gets its
              │  runtime, Mission       │   own process, cwd, lifetime
              │  Control, plan mode     │
              └─────────────────────────┘
```

## What each system contributes

| System | Source | Contribution |
| --- | --- | --- |
| **amaze** | `vendor/amaze` (full source + prebuilt darwin-arm64 native addon) | The agent runtime, unchanged. ACP over stdio: default/plan modes, model selection, content-block file attachments. Primary provider; Claude Code/Codex/etc. work alongside it. |
| **Paseo** | `vendor/paseo` (full source + Rocky branding/integration commits) | Everything server-side: session daemon, timeline sync, workspace/worktree registry, model catalog, attachments, terminals, schedules, permissions, MCP server, E2E relay — plus the Expo SPA that is now Rocky's one UI, and the Electron DMG. |
| **AionUi** | concept, re-implemented (no vendored code) | Team Mode orchestration semantics: Leader decomposes and delegates to parallel Teammates with a shared task board, async mailbox, per-agent permissions, and silent-agent escalation. Rocky implements this natively as the `rocky-orchestrate` skill over daemon MCP tools — no Electron app, no closed-source aioncore backend. |

### Why AionUi is a concept, not a vendor tree

AionUi's Team Mode is welded to its Electron main process and a closed-source
Rust backend (aioncore). Vendoring it meant a second UI, a second port, a
second state store, and an unbuildable binary dependency. Every Team Mode
primitive maps 1:1 onto daemon primitives Rocky already has:

| AionUi Team Mode | Rocky native |
| --- | --- |
| Leader agent | Any daemon agent loading `/rocky-orchestrate` |
| Teammate agents (parallel) | `create_agent` × N, worktree-isolated by default |
| Shared task board | `TEAM_BOARD.md` in the workspace (visible in the UI file tree) |
| Async mailbox | Daemon chat room (`chat create/post/wait`) |
| Per-agent permission dialogs | Daemon permission queue (`list_pending_permissions` / UI) |
| Silent-agent auto-escalation | Leader protocol step 5 (nudge → kill → reassign) |

The earlier two-UI integration (vendored AionUi + aioncore child process) was
built, verified, and then deliberately removed in favor of this design —
recorded in git history (`bd6bea7` → this commit).

## Single-origin serving

One ~20-line patch in `vendor/paseo/.../bootstrap.ts` adds `webUiDir` to the
daemon config: the built Expo SPA is served at the daemon root with SPA
fallback, while `/api`, `/ws`, `/public`, `/mcp`, `/download` keep their
existing handlers and auth. The browser talks to the same origin for UI, REST,
and WebSocket — no CORS hop, no second server, no extra port.

## Ports & state

| Surface | Where | State |
| --- | --- | --- |
| UI + API + WS | `:7767` (one port) | `~/.rocky` |
| amaze sessions | stdio children of rockyd | per-workspace |

No collision with stock Paseo (6767/`~/.paseo`) on the same machine.

## Self-containment policy

- `vendor/amaze` and `vendor/paseo` are full tracked source trees.
- One committed binary: `vendor/amaze/packages/natives/native/amaze_natives.darwin-arm64.node`
  (skips the Rust nightly toolchain; rebuildable via `bun run build:native`).
- The only network access setup needs is the npm/bun package registry.

## Repository layout

```
rocky/
├── ARCHITECTURE.md            ← this file
├── DESIGN.md                  ← decision record
├── README.md                  ← operations
├── package.json               ← npm run setup / start / smoke / cli / build:*
├── server/rockyd.ts           ← THE server entry (one process, one port)
├── config/rocky.config.json   ← ~/.rocky/config.json template
├── skills/rocky-orchestrate/  ← orchestrator mode (Leader/Teammate protocol)
├── scripts/
│   ├── setup.sh               ← vendor installs + build + skill link + config
│   ├── rockyd.sh              ← launcher (node, native TS)
│   ├── smoke.sh               ← regression contract (npm run smoke)
│   └── brand/make-icons.py    ← Rocky icon set generator
└── vendor/
    ├── amaze/                 ← agent runtime (separate CLI)
    └── paseo/                 ← server core + UI + DMG (Rocky-branded)
```
