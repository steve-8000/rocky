# Rust Rebuild Specification — Mission Control

This directory is the source-code-grounded development spec for rebuilding Rocky's host daemon/control plane in Rust.

The target is not a sidecar, not a wrapper, and not another daemon entrypoint. The target is one authoritative `rockyd` binary that owns the full host control plane and serves the existing WebUI build artifact.

## Source baseline reviewed

The requirements here were derived from the current implementation, not from the desired architecture alone:

- Entrypoints and runtime split:
  - `server/rockyd.ts`
  - `scripts/rockyd.sh`
  - `core/packages/server/scripts/supervisor-entrypoint.ts`
  - `core/packages/server/scripts/supervisor.ts`
  - `core/packages/server/src/server/daemon-worker.ts`
  - `core/packages/cli/src/commands/daemon/local-daemon.ts`
- Core daemon:
  - `core/packages/server/src/server/bootstrap.ts`
  - `core/packages/server/src/server/websocket-server.ts`
  - `core/packages/server/src/server/session.ts`
  - `core/packages/server/src/server/config.ts`
  - `core/packages/server/src/server/persisted-config.ts`
  - `core/packages/server/src/server/pid-lock.ts`
  - `core/packages/server/src/server/logger.ts`
- Agent control plane:
  - `core/packages/server/src/server/agent/agent-manager.ts`
  - `core/packages/server/src/server/agent/agent-storage.ts`
  - `core/packages/server/src/server/agent/agent-sdk-types.ts`
  - `core/packages/server/src/server/agent/mcp-server.ts`
  - `core/packages/server/src/server/agent/create-agent/create.ts`
  - `core/packages/server/src/server/agent/providers/acp-agent.ts`
  - `core/packages/server/src/server/agent/providers/generic-acp-agent.ts`
- Mission Control / orchestration surface:
  - `skills/rocky-orchestrate/SKILL.md`
  - `core/packages/app/src/screens/team-screen.tsx`
  - `core/packages/app/src/screens/team-model.ts`
  - `core/packages/protocol/src/agent-labels.ts`
  - `config/rocky.config.json`
- Wire and persistence contracts:
  - `core/packages/protocol/src/messages.ts`
  - `core/packages/protocol/src/agent-types.ts`
  - `core/docs/architecture.md`
  - `core/docs/data-model.md`

## Current structural defects to eliminate

The Rust rebuild exists because the current code has load-bearing responsibilities split across incompatible entrypoints:

1. `server/rockyd.ts` serves the single-port WebUI and sets `webUiDir`/`staticDir`, but does not use pid-lock, supervisor, restart/shutdown IPC, or crash supervision.
2. `supervisor-entrypoint.ts` and `daemon-worker.ts` implement pid-lock, restart/shutdown IPC, and crash recovery, but do not set the WebUI/static serving config that `rockyd.ts` owns.
3. `scripts/rockyd.sh`, `npm start`, `rocky daemon start`, desktop-managed daemon startup, and user-installed launchd plists can therefore run different daemon models for the same `$ROCKY_HOME` and port.
4. Mission Control is partly productized in the app and skill, but is still implemented as an emergent pattern over agents, labels, MCP tools, chat rooms, worktrees, and `TEAM_BOARD.md` rather than as a first-class daemon domain.

The Rust rewrite MUST end these splits. If the rewrite creates two ways to own the daemon, it has failed.

## Non-negotiable invariants

- Exactly one authoritative host daemon binary: `rockyd`.
- Exactly one daemon ownership protocol per `$ROCKY_HOME`: pid-lock + process liveness + socket/listen ownership.
- Exactly one network origin for UI, API, WebSocket, and MCP.
- Existing WebUI and client protocol remain compatible during migration.
- Existing `$ROCKY_HOME` data is read in place. No destructive migration is allowed.
- Mission Control becomes a first-class domain while preserving current Leader/Teammate behavior.
- Agent providers remain external subprocesses or protocol adapters until the Rust daemon reaches parity. Do not rewrite the agents themselves as part of daemon rebuild.
- No fallback second daemon, no alternate launch path, no hidden Node daemon in production final state.

## Document map

Read these in order:

1. [`01-runtime-architecture.md`](01-runtime-architecture.md) — final Rust daemon architecture, launch model, singleton ownership, HTTP/WS/MCP, WebUI serving, logging, lifecycle.
2. [`02-mission-control.md`](02-mission-control.md) — first-class Mission Control domain: missions, leaders, teammates, boards, mailbox, worktrees, permissions, UI/API behavior.
3. [`03-wire-and-storage-contracts.md`](03-wire-and-storage-contracts.md) — compatibility rules for WebSocket protocol, MCP, HTTP endpoints, JSON persistence, config, pid-lock, logs.
4. [`04-agent-runtime-and-providers.md`](04-agent-runtime-and-providers.md) — provider runtime contracts, ACP subprocess integration, MCP injection, timeline normalization, permissions, resume/rewind.
5. [`05-migration-and-verification.md`](05-migration-and-verification.md) — phased implementation plan, acceptance tests, cutover, decommissioning TS daemon paths.

## Meaning of Mission Control

"Mission Control" is the product-level replacement for today's loose "Team" and `rocky-orchestrate` pattern. It is the daemon-backed system that lets a human start a mission, launch a Leader agent, spawn Teammates, track work, coordinate through chat, isolate work through worktrees, handle permissions, verify results, and archive completed fleets.

The existing source already contains the pieces:

- Team screen starts a Leader with `buildLeaderBriefing()`.
- `rocky-orchestrate` instructs the Leader to create `TEAM_BOARD.md`, use a chat room as mailbox, and spawn Teammates through Rocky MCP tools.
- MCP `create_agent` stamps child agents with `rocky.parent-agent-id` unless detached.
- App `groupAgentsIntoTeams()` groups daemon agents by that label.
- Chat service stores rooms/messages in `$ROCKY_HOME/chat/rooms.json`.
- Worktree service creates and archives per-task isolation.
- Permission queue is already daemon-mediated.

The Rust daemon must make this explicit and testable instead of relying on convention alone.
