# Rocky Architecture

Rocky is a self-contained agent-orchestration platform: **one process, one
port, one UI**. Version 0.1.0 is a clean rebuild — every surface (name, theme,
icons, endpoints, package identity) is Rocky's own.

```
                    ┌──────────────────────────────────────────┐
 browser ── :7767 ─▶│ rockyd (single Node process)             │
                    │  ├─ web UI  (Expo SPA served at /)       │
                    │  ├─ REST    (/api/*)                     │
                    │  ├─ WS      (/ws — timeline + terminal)  │
                    │  └─ MCP     (/mcp/agents — agent tools)  │
                    │                                          │
                    │  daemon core (in-process library)        │
                    │  ├─ agent lifecycle + permission queues  │
                    │  ├─ workspaces / git worktrees           │
                    │  ├─ file attachments + downloads         │
                    │  └─ orchestrator mode (Leader/Teammates) │
                    └───────────────┬──────────────────────────┘
                                    │ ACP (stdio, per session)
                            vendor/amaze CLI (bun)
```

## Layout

| Path | Role |
| --- | --- |
| `server/rockyd.ts` | The single server entry point. Boots the daemon core in-process and serves the SPA, API, WS, and MCP from one port (7767). |
| `core/` | Rocky's runtime monorepo: `packages/server` (daemon core), `packages/app` (Expo SPA + desktop renderer), `packages/cli` (`rocky` CLI), `packages/desktop` (DMG packaging), plus protocol/client/highlight libraries. |
| `vendor/amaze` | The agent runtime, vendored unchanged. Registered as an ACP provider; rockyd spawns one `bun …/cli.ts acp` per agent session. |
| `skills/rocky-orchestrate` | Orchestrator mode: a Leader agent decomposes work and delegates to parallel Teammate agents over Rocky's MCP tools (`create_agent`, `wait_for_agent`, `send_agent_prompt`, …) with a shared task board and per-agent permissions. |
| `config/rocky.config.json` | Config template written to `~/.rocky/config.json` on setup. |
| `scripts/` | `setup.sh`, `rockyd.sh` (start), `smoke.sh` (regression contract), `brand/make-icons.py` (generates every icon/favicon/splash from the faceted-rock mark). |

## Design system

- **Mark**: a faceted rock; one geometry shared by the app icon
  (`scripts/brand/make-icons.py`) and the in-app `RockyLogo` component.
- **Default theme**: warm charcoal surfaces with a copper accent
  (`core/packages/app/src/styles/theme.ts`, `rockyDarkColors`). Alternate
  themes (light/zinc/midnight/…) remain user-selectable.
- All favicons, PWA icons, splash, and desktop `.icns/.ico` are generated from
  the same script — `npm run icons` regenerates the full set.

## Security model

- Daemon listens on loopback; remote access goes through a TLS edge proxy.
- A daemon password (bcrypt) gates every HTTP/WS surface except `/api/health`.
- Agent-injected MCP self-calls authenticate with a boot-scoped internal token
  (`?rockyToken=`) valid only under `/mcp/`.
- No external services: relay is disabled by default, there is no hosted
  update feed, and the app phones home nowhere.

## Regression contract

`npm run smoke` boots a throwaway instance and asserts:
1. vendored amaze CLI runs standalone
2. rockyd is a single process on a single port
3. Rocky UI served at `/` (`<title>Rocky`)
4. SPA deep-link fallback
5. REST API on the same origin
6. daemon ⇄ amaze E2E agent run produces a real file
7. brand scrub — the served bundle contains no upstream branding
