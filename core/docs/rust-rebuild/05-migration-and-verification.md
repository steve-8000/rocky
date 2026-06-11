# 05 — Migration and Verification Plan

## Goal

Move Rocky from the current split TypeScript daemon runtime to the final Rust `rockyd` without losing data, breaking existing clients, or creating another competing daemon path.

This is a clean cutover plan with explicit gates. A phase is not complete until its acceptance criteria pass.

## Migration principles

- Build against source contracts, not memory.
- Keep existing WebUI and app protocol working during migration.
- Read existing `$ROCKY_HOME` in place.
- Avoid dual-write until absolutely necessary.
- Do not run two daemons against the same `$ROCKY_HOME`.
- Do not create a second production entrypoint as a temporary "solution".
- Every temporary bridge must have a removal condition and owner.

## Phase 0 — Contract capture

Purpose: freeze current behavior before rewriting.

### Tasks

1. Capture fixture messages from current TypeScript daemon:
   - `server_info`
   - agent create/list/status/stream
   - fetch timeline
   - provider snapshots
   - permission request/resolution
   - workspace updates
   - terminal messages
   - chat responses
   - schedule/loop responses
   - daemon config get/set
2. Capture fixture storage from a sanitized `$ROCKY_HOME`:
   - config
   - agent records with timeline rows
   - chat rooms
   - schedules
   - loops
   - projects/workspaces
   - pid-lock
   - daemon keypair/server id
3. Build a fixture validation harness that runs TypeScript zod schemas against captured JSON.
4. Build matching Rust deserialization tests.

### Acceptance criteria

- Rust can parse all captured persisted files in read-only mode.
- Rust can parse all captured client inbound messages.
- TypeScript clients can parse Rust-emitted fixture messages.

## Phase 1 — Rust shell and singleton

Purpose: create `rockyd` binary that owns process identity correctly before implementing business logic.

### Tasks

1. Create Rust workspace and `rockyd` binary.
2. Implement config root resolution and `$ROCKY_HOME` creation.
3. Implement pid-lock read/write/stale detection.
4. Implement listen parsing and HTTP health route.
5. Implement structured logging and log rotation.
6. Implement foreground launch behavior for launchd/systemd.
7. Implement `rockyd daemon status/stop/restart` against pid-lock and lifecycle endpoint.

### Acceptance criteria

- Starting two `rockyd` instances with same `$ROCKY_HOME` fails before bind.
- Stale pid-lock is detected and repaired.
- `rockyd daemon status` reports PID/listen/uptime.
- SIGINT/SIGTERM remove pid-lock only for owner.
- launchd/systemd can run the binary in foreground mode.

## Phase 2 — WebUI, auth, HTTP, WebSocket handshake

Purpose: make existing clients connect to Rust daemon without agent functionality.

### Tasks

1. Serve WebUI build artifact at `/`.
2. Preserve SPA fallback and reserved prefixes.
3. Implement Host validation and CORS.
4. Implement password/bearer auth for protected routes.
5. Implement `/ws` hello handshake and `server_info`.
6. Implement JSON ping/pong.
7. Implement daemon config get/status read-only endpoints.

### Acceptance criteria

- Existing WebUI loads from Rust daemon at `http://host:7767/`.
- Existing app can connect and receive `server_info`.
- Invalid Host header returns 403.
- Protected API rejects unauthenticated calls as current daemon does.
- WebUI assets remain public.

## Phase 3 — Storage and read-only projections

Purpose: reconstruct UI state from existing `$ROCKY_HOME` before launching agents.

### Tasks

1. Implement config parsing with env overlay.
2. Implement server-id and daemon-keypair parsing.
3. Implement agent storage parser and list/fetch projections.
4. Implement project/workspace registry parser and reconciliation baseline.
5. Implement chat store read/list.
6. Implement schedule/loop read/list.
7. Implement provider config parser for custom providers.

### Acceptance criteria

- Existing WebUI shows agents/workspaces/config from real `$ROCKY_HOME`.
- Agent list matches TypeScript daemon for same fixture home.
- Timeline fetch returns same rows and sequence semantics.
- Unknown optional fields are preserved or ignored safely.

## Phase 4 — Agent manager and ACP provider runtime

Purpose: create/run/resume agents through Rust, starting with ACP and vendored amaze.

### Tasks

1. Implement AgentManager state machine.
2. Implement timeline append/persist/broadcast.
3. Implement provider snapshot manager.
4. Implement generic ACP subprocess client.
5. Implement vendored amaze provider config expansion.
6. Implement permission queue.
7. Implement Rocky MCP injection and token refresh.
8. Implement agent create/send/wait/cancel/archive.
9. Implement provider shutdown and process cleanup.

### Acceptance criteria

- Create and run an amaze agent from existing WebUI.
- Agent stream appears live and persists.
- Permissions prompt and resolve correctly.
- Agent resumes after daemon restart.
- Agent-created Teammate receives `rocky.parent-agent-id`.
- No provider subprocess survives daemon shutdown.

## Phase 5 — MCP server and Mission Control foundations

Purpose: make agent-to-agent orchestration work through Rust.

### Tasks

1. Implement `/mcp/agents` top-level and agent-scoped sessions.
2. Implement current MCP tool set:
   - create/wait/send/status/list/cancel/kill/archive/update agent
   - terminals
   - schedules/heartbeats
   - provider list/models/inspect
   - worktree list/create/archive
   - activity
   - permissions
3. Implement chat APIs needed by CLI and mission mailbox.
4. Add Mission store under `$ROCKY_HOME/missions`.
5. Implement mission create/list/inspect/update/cancel/archive.
6. Generate `TEAM_BOARD.md` projection.
7. Attach mission/task labels to agents.

### Acceptance criteria

- `rocky-orchestrate` skill works against Rust daemon.
- Existing MCP parity tests for parent labels/worktrees pass against Rust.
- A mission can be reconstructed after daemon restart.
- Team screen grouping still works through parent labels.

## Phase 6 — Workspaces, worktrees, git, terminals, service proxy

Purpose: reach day-to-day developer workflow parity.

### Tasks

1. Implement workspace registry updates and reconciliation.
2. Implement worktree creation/archive and setup command projection.
3. Implement checkout/git status, diff, commit, merge, pull, push, PR operations.
4. Implement terminal PTY manager and binary frame protocol.
5. Implement workspace script runtime and health monitor.
6. Implement service proxy host routing and standalone listener if retained.

### Acceptance criteria

- Existing workspace UI works.
- Worktree-backed Teammate tasks can be created and archived.
- Terminal subscribe/input/capture works from app and CLI.
- Service proxy routes workspace scripts and never falls through to daemon APIs for known service hosts.

## Phase 7 — Schedules, loops, relay, push, voice

Purpose: complete non-core but user-visible subsystems.

### Tasks

1. Implement schedule store and runner.
2. Implement loop service and recovery semantics.
3. Implement relay transport and E2EE pairing.
4. Implement push token store and notification paths.
5. Implement speech/dictation/voice or explicit capability gates.

### Acceptance criteria

- Existing schedule and loop commands work.
- Relay pairing and direct/relay connection work.
- Push notifications fire for attention/permissions where current server does.
- Voice UI either works or is cleanly disabled by capability.

## Phase 8 — Cutover and decommission

Purpose: remove split runtime and make Rust the only daemon.

### Tasks

1. Change `npm start` to call Rust `rockyd --foreground` or remove it in release builds.
2. Change `scripts/rockyd.sh` to exec Rust `rockyd` only, or delete it.
3. Change CLI daemon start/stop/status to call Rust binary or Rust daemon APIs.
4. Change desktop daemon manager to spawn Rust binary.
5. Remove or shim TypeScript daemon entrypoints:
   - `server/rockyd.ts`
   - `supervisor-entrypoint.ts`
   - `supervisor.ts`
   - `daemon-worker.ts`
6. Installer/upgrader removes stale launchd labels.
7. Docs update: port 7767, one binary, one service.

### Acceptance criteria

- Repository contains one production daemon implementation.
- `launchctl list | grep rocky` shows one job after install.
- `lsof -nP -iTCP:7767 -sTCP:LISTEN` shows one owner.
- `rockyd`, CLI, desktop, and launchd all use same binary path.
- No TS daemon can accidentally bind the production port.

## Regression suite

### Runtime

- singleton lock prevents duplicate start
- stale lock recovery
- signal shutdown releases lock
- restart request restarts same binary
- EADDRINUSE produces bounded diagnostic only
- log rotation works

### HTTP/WebUI

- `/` returns WebUI index
- SPA fallback works
- `/api`, `/ws`, `/mcp`, `/download`, `/public` are reserved correctly
- invalid Host returns 403
- auth accepts/rejects as current server

### WebSocket

- hello/server_info
- ping/pong
- reconnect and timeline catch-up
- request/response correlation
- rpc_error shape
- binary terminal frames

### Agents

- create/run/wait
- send while idle/running behavior
- cancel/kill/archive/delete
- resume after restart
- provider mode/model/thinking/feature mutation
- permission request/resolve
- tool-call timeline normalization
- stale injected MCP URL refresh

### Mission Control

- create mission creates Leader/chat/board/record
- Leader creates Teammate with parent and mission labels
- worktree isolation for code tasks
- mailbox summary capture
- board task status update
- permission has mission context
- verification required before completed
- archive mission archives children or records retention

### Persistence

- parse current `$ROCKY_HOME`
- write atomic records
- preserve unknown fields where required
- recover from partial/temp writes
- no destructive migration

### Providers

- amaze ACP full run
- generic ACP mode normalization and bypass
- provider unavailable diagnostic
- provider subprocess cleanup
- provider stderr/stdout logging with redaction

## Cutover safety checklist

Before enabling Rust daemon by default:

- Full backup of `$ROCKY_HOME` taken by installer/upgrader.
- TypeScript daemon disabled but recoverable by explicit rollback command.
- Rust daemon can run read-only health check on home before taking lock.
- Rust daemon writes a migration marker only after successful start.
- Rollback does not require modifying stored agent records.
- Launch service points to exactly one binary.
- Existing live agents are allowed to finish or are explicitly interrupted with user consent.

## Rollback plan

Rollback is allowed only during migration phases, not as a permanent alternate runtime.

Steps:

1. Stop Rust daemon.
2. Restore previous launch service command.
3. Start TypeScript daemon.
4. Verify WebUI and agent list.
5. Capture Rust failure logs and fixture that failed.
6. Do not keep both launch services enabled.

## Documentation updates required before final release

- `README.md`: replace Node daemon startup with Rust `rockyd` instructions.
- `core/docs/architecture.md`: update daemon from Node.js to Rust, update deployment model and port.
- `core/docs/development.md`: update build/test/start workflows.
- `core/docs/data-model.md`: add missions store and confirm unchanged file formats.
- `TROUBLESHOOTING.md`: replace duplicate launchd incident with prevention mechanism and stale service cleanup.
- CLI help: update daemon commands if binary changes.

## Definition of done

The Rust rebuild is done only when:

- There is one daemon binary and one production daemon path.
- Mission Control is first-class and durable.
- Existing WebUI works without a compatibility fork.
- Existing `$ROCKY_HOME` works without destructive migration.
- Existing core CLI commands work.
- Existing vendored amaze provider can run orchestration missions.
- TypeScript daemon implementation is removed or cannot bind the production port.
- Contract fixtures prove wire/storage compatibility.
