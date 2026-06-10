# Rocky — Design

Rocky is a single server + remote WebUI + desktop app that integrates three systems:

| Layer | Source | What Rocky takes |
| --- | --- | --- |
| Agent runtime | **amaze** (`~/roy/amaze/amaze`) | The full amaze CLI, unchanged. Exposed to Rocky over ACP (`amaze acp`). |
| Server core | **Paseo** (vendored at `vendor/paseo`) | Session daemon, workspace/worktree registry, model/provider catalog, file attachments, terminals, schedules, MCP server, relay, web client. |
| Orchestration | **AionUi** (Team Mode concept) | Leader/Teammate orchestrator mode, re-implemented as a Rocky skill on top of the Paseo MCP/CLI surface instead of AionUi's Electron-internal Team MCP server. |

## Why this shape

A rewrite of Paseo's daemon (agent lifecycle, timeline sync, E2E relay, binary terminal frames) would be months of high-risk work for zero product delta. Likewise, AionUi's Team Mode is tightly coupled to its Electron main process; what is portable is the *behavior*: a Leader agent that decomposes work, delegates to parallel Teammates, tracks a shared task board, and aggregates results. Paseo's daemon already exposes every primitive that behavior needs (`create_agent`, `wait_for_agent`, `send_agent_prompt`, chat rooms as the async mailbox, worktrees as isolation). So:

- **Paseo daemon = Rocky server.** Vendored as a git worktree (`vendor/paseo`, branch `rocky`) so upstream merges stay one `git merge` away. Branding/config diffs live on the `rocky` branch.
- **amaze = first-class provider.** Paseo supports ACP providers in config; amaze ships `amaze acp` (stdio ACP server with default/plan modes, model selection, file attachments via ACP content blocks). No code change needed on either side — pure configuration in `~/.rocky/config.json` (`ROCKY_HOME` → `PASEO_HOME`).
- **Orchestrator mode = skill + MCP.** `skills/rocky-orchestrate` implements the AionUi Leader/Teammate protocol using Paseo MCP tools. Any provider (amaze, Claude Code, Codex) can be the Leader; Teammates run in parallel as daemon-managed agents sharing the workspace, with per-agent permission queues — same semantics as AionUi's team-isolated workspace.

## Architecture

```
┌────────────┐   ┌────────────┐   ┌─────────────────────┐
│ Rocky.app   │   │ Browser    │   │ Paseo mobile app    │
│ (Electron,  │   │ (remote    │   │ (optional, Direct/  │
│  DMG)       │   │  WebUI)    │   │  relay connection)  │
└──────┬──────┘   └─────┬──────┘   └──────────┬──────────┘
       │ managed daemon │ ws://host:7767      │
       └────────────┬───┴─────────────────────┘
              ┌─────▼──────┐
              │ Rocky      │  = Paseo daemon, ROCKY_HOME=~/.rocky
              │ daemon     │  listen 0.0.0.0:7767, password auth
              └─────┬──────┘
        ┌───────────┼───────────────┬─────────────┐
  ┌─────▼─────┐ ┌───▼──────────┐ ┌──▼───────┐ ┌───▼────┐
  │ amaze     │ │ Claude Code  │ │ Codex    │ │  ...   │
  │ (ACP)     │ │              │ │          │ │        │
  └───────────┘ └──────────────┘ └──────────┘ └────────┘
        Leader agent ──MCP──► create_agent / wait_for_agent /
                              send_agent_prompt / chat mailbox
                              (rocky-orchestrate skill)
```

### Core technology carried over from Paseo

- **Session daemon** — agent lifecycle state machine, append-only timeline with epochs, reconnect-safe sync.
- **Workspaces & worktrees** — project/workspace registry, Paseo-managed git worktrees for isolated parallel work (this is what makes parallel Teammates safe).
- **Models/providers** — provider catalog with custom providers, profiles, per-provider model lists; amaze added as ACP entry.
- **File attachments** — composer attachments + binary file-transfer frames, work end-to-end through daemon to providers (ACP content blocks for amaze).
- **Remote access** — direct `0.0.0.0` listen with password + host allowlist, or the E2E-encrypted relay; WebUI is the Expo web export served at the daemon origin.

### Orchestrator mode (from AionUi Team Mode)

`skills/rocky-orchestrate/SKILL.md` defines the protocol:

1. **Leader** receives the goal, writes a task board (`TEAM_BOARD.md` in the workspace — AionUi's shared task board equivalent).
2. Decomposes into independent subtasks; for each, creates a **Teammate** agent via `create_agent` (optionally `worktree: true` for conflict-free parallel edits; AionUi shares one folder — Rocky supports both, worktree is the default for code).
3. A daemon **chat room** is the async mailbox: Teammates post completion/blockers, Leader `wait`s on the room.
4. Leader monitors with `wait_for_agent` / `get_agent_activity`, reassigns or kills silent agents (AionUi's auto-escalate-failed), aggregates results, updates the board, reports.
5. Permissions stay per-agent (daemon permission queue = AionUi's per-agent permission dialogs).

## Key decisions (current — see ARCHITECTURE.md for the authoritative layout)

- **Self-contained vendoring.** `vendor/{amaze,paseo,aionui}` are full source trees committed to this repository (originally a git worktree of `~/roy/paseo`; detached when self-containment became a requirement). Upstream sync is a re-export + replay of Rocky commits.
- **One server process.** Paseo daemon and AionUi web-host run inside a single Node runtime (`server/rockyd.ts`). aioncore (AionUi's closed-source Rust backend) is the only managed child process; amaze stays a separate CLI for per-session process isolation.
- **Port 7767, home `~/.rocky`.** Avoids colliding with stock Paseo (6767/`~/.paseo`). All Rocky state, including AionUi's, lives under `~/.rocky`.
- **amaze is vendored, not PATH-resolved.** Both the daemon ACP provider and the AionUi custom agent point at `vendor/amaze/packages/coding-agent/src/cli.ts` via Bun.
- **DMG ad-hoc signed for now.** No Developer ID identity on this machine. Signing/notarization is a config flip in `vendor/paseo/packages/desktop/electron-builder.yml` when credentials exist.
