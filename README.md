# Rocky

Self-contained agent-orchestration platform: a daemon, a web UI, a CLI, a
desktop app, and the amaze agent runtime — **one process, one port, one UI**.

## Quick start

```sh
npm run setup    # install deps, build server + web UI, write ~/.rocky/config.json
npm start        # rockyd → http://<host>:7767 (UI + API + WS + MCP, one port)
```

Before exposing port 7767 anywhere, set a daemon password:

```sh
npm run cli -- daemon set-password
```

## Commands

| Command | Effect |
| --- | --- |
| `npm run setup` | Full self-contained setup (no network besides npm). |
| `npm start` | Start rockyd in the foreground. |
| `npm run smoke` | Regression contract: 7 acceptance checks incl. an end-to-end amaze agent run and a brand scrub. |
| `npm run cli -- <cmd>` | Rocky CLI (`agent run`, `daemon set-password`, …). |
| `npm run build:webui` | Rebuild the web UI bundle. |
| `npm run build:dmg` | Build the Rocky macOS app + DMG. |
| `npm run icons` | Regenerate all brand assets from the faceted-rock mark. |

## Orchestrator mode

The `rocky-orchestrate` skill (installed to `~/.agents/skills` by setup) turns
any agent into a Leader that decomposes a goal, spawns parallel Teammate
agents through Rocky's MCP tools, tracks a shared task board, and aggregates
results. See `skills/rocky-orchestrate/SKILL.md`.

## Layout

- `server/rockyd.ts` — single server entry
- `core/` — Rocky runtime monorepo (server, app, cli, desktop, protocol)
- `vendor/amaze` — vendored agent runtime (ACP provider)
- `ARCHITECTURE.md` — full design
