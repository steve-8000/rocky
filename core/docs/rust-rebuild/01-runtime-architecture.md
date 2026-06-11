# 01 — Runtime Architecture

## Goal

Build one Rust `rockyd` binary that replaces all current daemon entrypoints:

- `server/rockyd.ts`
- `scripts/rockyd.sh` as daemon implementation
- `core/packages/server/scripts/supervisor-entrypoint.ts`
- `core/packages/server/scripts/supervisor.ts`
- `core/packages/server/src/server/daemon-worker.ts`

The final binary owns daemon lifecycle, singleton locking, HTTP/WebSocket/MCP serving, WebUI static serving, agent control, persistence, logging, relay, service proxy, schedules, loops, chat, worktrees, and Mission Control.

`rockyd` MUST be usable as:

```sh
rockyd --foreground
rockyd daemon status
rockyd daemon stop
rockyd daemon restart
rockyd daemon set-password
```

The TypeScript CLI may remain temporarily as a thin client, but final daemon ownership belongs to Rust.

## Current source facts

### Current `rockyd.ts` path

`server/rockyd.ts` currently:

- imports `createRockyDaemon()` and `loadConfig()` from built server dist
- sets `process.title = "rockyd"`
- resolves `WEB_UI_DIST = core/packages/app/dist`
- creates `$ROCKY_HOME/public`
- sets `config.staticDir = $ROCKY_HOME/public`
- verifies `WEB_UI_DIST/index.html` exists
- sets `config.webUiDir = WEB_UI_DIST`
- starts the daemon in-process
- handles SIGINT/SIGTERM by calling `daemon.stop()`

It does not acquire `rocky.pid`, does not supervise a worker, and does not handle daemon restart/shutdown lifecycle intents from WebSocket sessions.

### Current supervisor path

`core/packages/server/scripts/supervisor-entrypoint.ts` currently:

- resolves worker entrypoint
- loads persisted config
- acquires pid-lock through `acquirePidLock(rockyHome, null, { ownerPid: process.pid })`
- starts `runSupervisor()`
- updates pid-lock with listen target on worker ready
- releases pid-lock on supervisor exit

`core/packages/server/scripts/supervisor.ts` currently:

- spawns/forks the worker with IPC
- logs worker stdout/stderr into daemon log
- restarts on crash
- accepts `rocky:ready`, `rocky:restart`, `rocky:shutdown`
- handles SIGINT/SIGTERM

`core/packages/server/src/server/daemon-worker.ts` currently:

- calls `createRockyDaemon()`
- sends `rocky:ready` after listen
- sends restart/shutdown intents to supervisor
- handles parent IPC disconnect by graceful shutdown

It does not set `webUiDir` or absolute `$ROCKY_HOME/public` static dir. Those are only in `server/rockyd.ts` today.

## Target process model

Final state:

```text
launchd/systemd/user shell/desktop/CLI
  -> rockyd (Rust, foreground daemon process)
       owns pid-lock
       owns HTTP listener
       owns WebSocket sessions
       owns MCP server
       owns agent/session managers
       spawns provider subprocesses directly
```

There is no daemon worker child in final production. If a temporary bridge exists during migration, it MUST be explicitly marked as transitional and removed before final parity.

## Singleton ownership

`rockyd` MUST enforce a single owner per `$ROCKY_HOME`.

### Lock file

Path: `$ROCKY_HOME/rocky.pid`

Current schema from `pid-lock.ts` / data model:

```json
{
  "pid": 12345,
  "startedAt": "2026-06-10T00:00:00.000Z",
  "hostname": "host",
  "uid": 501,
  "listen": "127.0.0.1:7767",
  "desktopManaged": false
}
```

Rust MUST preserve this shape and accept missing optional fields.

### Lock algorithm

On start:

1. Resolve `$ROCKY_HOME` from env/defaults.
2. Ensure the directory exists with private permissions where supported.
3. Read `rocky.pid` if present.
4. If PID exists and is alive for same uid/host, reject start unless explicit takeover mode is requested.
5. If PID is dead, remove stale lock and continue.
6. Write lock atomically with `listen: null` before binding the HTTP listener.
7. After successful bind, update lock atomically with final listen target.
8. On graceful shutdown, remove lock only if owner PID matches current process.

Rust MUST NOT use port bind failure as the primary singleton mechanism. `EADDRINUSE` is a diagnostic, not the lock.

### Multiple launch services

The final system MUST have exactly one installed service per user/host:

- macOS: one LaunchAgent label, e.g. `one.clab.rocky`
- Linux: one systemd user service, e.g. `rocky.service`

Installer/upgrader MUST detect and remove or disable stale labels known from source history, including `one.clab.rocky.rockyd`.

## Listen model

Default listen in current config template is `0.0.0.0:7767`; docs still contain older `6767` references and must be updated during migration.

Rust MUST support the current `listen` grammar implemented in `bootstrap.ts`:

- TCP port-only strings such as `7767`
- TCP `host:port`
- POSIX absolute socket paths
- `unix://` socket paths
- Windows named pipe forms if Windows support remains in scope
- reject invalid Windows drive paths as listen targets

Bound listen target MUST be reported in:

- pid-lock `listen`
- server_info status payload
- daemon status CLI response
- injected Rocky MCP URL
- logs

## HTTP server

Rust owns one HTTP server for all surfaces:

```text
/                       WebUI SPA and static assets
/api/...                 daemon HTTP APIs
/ws                      WebSocket protocol
/mcp/agents              MCP server for agents and top-level clients
/download/...            download token endpoints
/public/...              public/static host files from $ROCKY_HOME/public
service proxy hosts      workspace service proxy routing
```

### Host validation

Preserve the behavior from `bootstrap.ts`:

- For TCP listeners, validate Host header against configured `hostnames`/legacy `allowedHosts`.
- For non-TCP listeners, skip Host validation.
- Service proxy host classification happens before daemon auth and route fallthrough.

### CORS

Preserve same-origin plus configured `cors.allowedOrigins`, and include packaged desktop origin `rocky://app`.

### Auth

Preserve bearer/password behavior:

- WebUI assets are public.
- API/WS/MCP/download endpoints are protected where current server protects them.
- Internal MCP token is boot-scoped and must be rederived on resume/reload instead of accepting stale tokens.
- Never widen token acceptance to mask stale token bugs.

## WebUI serving

Rust MUST serve the existing Expo web build artifact at daemon root.

Current `rockyd.ts` behavior to preserve:

- `WEB_UI_DIST = <repo-root>/core/packages/app/dist`
- fail fast with a clear error if `WEB_UI_DIST/index.html` is missing
- set SPA fallback for non-reserved GET/HEAD paths
- reserved prefixes: `/api`, `/public`, `/mcp`, `/ws`, `/download`
- static files are public; API/WS remain protected

Final source of WebUI path should be configurable but deterministic:

1. Explicit `ROCKY_WEB_UI_DIR` env override.
2. Packaged path next to the Rust binary for releases.
3. Repo dev path `core/packages/app/dist` when running from source.

Do not silently start without WebUI unless an explicit `--api-only` flag is set. The product contract is one process, one port, one UI.

## Logging

Current code has two log channels:

- structured daemon logger in `logger.ts`, usually `$ROCKY_HOME/daemon.log`
- supervisor log stream with rotation in `supervisor.ts`

Rust MUST collapse this into one logging system:

- structured JSON lines by default
- configurable console/file levels and format
- rotation honors current `log.file.rotate.maxSize` and `maxFiles`
- stdout/stderr suitable for launchd/systemd foreground mode
- fatal startup errors are one clear record plus exit code, not stack spam loops

Important incident rule: repeated `EADDRINUSE` must never create unbounded logs. If a second process starts while lock is owned, it exits with a clear singleton error before binding.

## Lifecycle

Rust MUST implement lifecycle commands from WebSocket session messages:

- `restart_server_request`
- `shutdown_server_request`

Current Node behavior routes these through `DaemonLifecycleIntent` to supervisor IPC. Final Rust behavior:

- `shutdown`: broadcast shutdown requested, stop accepting new requests, gracefully close sessions and agents, stop provider subprocesses, flush logs, remove pid-lock, exit 0.
- `restart`: same graceful shutdown, then exec self or ask service manager to restart. Exactly one restart mechanism per platform.

The server must not ignore lifecycle intents in the WebUI path.

## Graceful shutdown ordering

Required shutdown order:

1. Mark daemon state `stopping`.
2. Stop accepting new HTTP/WS/MCP connections.
3. Notify connected clients with shutdown/restart status.
4. Stop schedules/loops from launching new work.
5. Request active provider sessions to interrupt/close.
6. Stop terminals and workspace scripts.
7. Stop relay transport and service proxy.
8. Flush storage queues.
9. Flush logs.
10. Release pid-lock if owner.
11. Exit.

Use a bounded force timeout. On timeout, log the blocking subsystem and exit non-zero only when data safety requires it.

## Crate/module layout

Recommended Rust workspace:

```text
rust/
  Cargo.toml
  crates/
    rockyd/                 binary and CLI entrypoint
    rocky-config/           config parsing, env overlay, schema compatibility
    rocky-store/            JSON stores and atomic writes
    rocky-protocol/         WS/MCP/HTTP DTOs generated or hand-written from TS schemas
    rocky-http/             axum/hyper routes, auth, WebUI, download/public files
    rocky-ws/               WebSocket sessions, protocol framing, binary terminal frames
    rocky-mcp/              MCP server implementation
    rocky-agents/           AgentManager, provider interface, timeline, permissions
    rocky-providers/        ACP/generic provider adapters and subprocess runners
    rocky-mission-control/  missions, teams, boards, mailboxes, worktrees integration
    rocky-workspaces/       project/workspace registry, git/worktree services
    rocky-service-proxy/    workspace service proxy and health monitor
    rocky-relay/            relay transport and E2EE
    rocky-terminal/         PTY/session runtime
    rocky-speech/           dictation/voice integration if retained in Rust phase
```

Keep crates boring. Do not create framework abstractions before parity tests require them.

## Technology choices

Recommended defaults:

- async runtime: `tokio`
- HTTP/WebSocket: `axum` + `tower` + `tokio-tungstenite` or axum WS
- JSON: `serde` / `serde_json`
- validation: explicit Rust validators plus JSON compatibility tests against captured fixtures
- filesystem: atomic temp-file + rename helper in `rocky-store`
- process management: `tokio::process`
- PTY: platform-specific crate behind `rocky-terminal`
- logs: `tracing` + JSON formatter + file rotation
- crypto: audited crates matching current relay primitives; compatibility tests required

## Runtime anti-goals

- No second daemon entrypoint.
- No Node daemon in final production path.
- No "start anyway on a different port" fallback.
- No schema rewrite that forces clients to update first.
- No database migration unless explicitly approved later.
- No silent best-effort provider behavior that drops timeline or permission events.

## Acceptance criteria

Runtime architecture is complete only when:

- `rockyd --foreground` serves `/` WebUI and `/ws` on the configured listen address.
- `rockyd daemon status` reports owner PID and listen target from the same pid-lock the daemon owns.
- Starting a second `rockyd` with the same `$ROCKY_HOME` fails before attempting to bind.
- WebUI restart/shutdown requests work.
- launchd/systemd/desktop/CLI all invoke the same binary and same code path.
- Existing TS daemon entrypoints are deleted or reduced to compatibility shims that exec Rust `rockyd`.
