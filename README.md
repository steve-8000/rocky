# Rocky

Self-contained agent-orchestration platform: a daemon, a web UI, a CLI, a
desktop app, and the amaze agent runtime — **one process, one port, one UI**.

## Installation

### Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | ≥ 23 | Rocky daemon + build toolchain |
| [Bun](https://bun.sh) | ≥ 1.3 | Runs the vendored amaze agent runtime |
| [git](https://git-scm.com) | any | Clone the repo |

macOS and Linux are supported. The daemon and the agent runtime run on the
host (they need native Keychain / process access), so containerizing them is
not supported.

### Steps

```sh
git clone https://github.com/steve-8000/rocky.git
cd rocky
npm run setup    # install deps, build server + web UI, write ~/.rocky/config.json
npm start        # rockyd → http://<host>:7767 (UI + API + WS + MCP, one port)
```

`npm run setup` is fully self-contained (no network beyond npm/bun registries):
it installs dependencies for both vendored trees, builds the Rocky server
library and web UI, installs the `rocky-orchestrate` skill into
`~/.agents/skills`, and writes `~/.rocky/config.json` from
`config/rocky.config.json` (registering the vendored amaze as an ACP provider).
An existing `~/.rocky/config.json` is never overwritten.

### Set a daemon password

Port 7767 serves the UI, API, and WebSocket on one origin. **Before exposing it
beyond localhost, set a password:**

```sh
npm run cli -- daemon set-password
```

The hash is stored at `~/.rocky/.admin-password` (mode `700` dir). No secrets
are committed to this repo — provider credentials live in `~/.amaze`, daemon
secrets in `~/.rocky`, both outside the source tree.

## Remote access (direct connection)

Rocky serves the UI and API on one origin, so a reverse proxy is all you need
for remote access. The production deployment:

| Field | Value |
| --- | --- |
| URL | https://rocky.clab.one |
| Host | `rocky.clab.one` |
| Port | `443` (TLS on; Caddy → `127.0.0.1:7767`) |
| Password | `~/.rocky/.admin-password` on the host (set via `npm run cli -- daemon set-password`) |

Open the URL, choose **Direct connection** — host, port, and SSL are
prefilled from the page origin; enter the daemon password to connect.
For LAN use without a proxy, connect to `<host>:7767` with SSL off.

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
- `TROUBLESHOOTING.md` — known failure modes (duplicate launchd jobs, stale `rockyToken` 401s)
