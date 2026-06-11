# 03 — Wire and Storage Contracts

## Goal

The Rust daemon must be a drop-in replacement for the current daemon from the perspective of existing WebUI, mobile app, CLI, desktop app, MCP clients, and persisted `$ROCKY_HOME` data.

This document defines contracts that cannot be broken during the Rust rebuild.

## Protocol source of truth

Current TypeScript source:

- `core/packages/protocol/src/messages.ts`
- `core/packages/protocol/src/agent-types.ts`
- `core/packages/protocol/src/agent-labels.ts`
- `core/packages/protocol/src/daemon-endpoints.ts`
- `core/docs/rpc-namespacing.md`

Rust MUST either generate compatible types from these schemas or maintain conformance tests against them. Hand-written Rust DTOs are acceptable only when tested against captured fixtures from the TypeScript schemas.

## Compatibility rules

Preserve current rules from `core/docs/architecture.md`:

- WebSocket schemas are append-only.
- Add fields; do not remove fields.
- Never make optional fields required.
- New enum values require capability gating.
- Session stores client capabilities from `hello`; server emits only what the client supports.
- New request/response RPCs use dotted names with `.request`/`.response` suffixes.
- Back-compat shims must be tagged and dated.

Rust MUST be stricter internally than at the wire boundary: parse permissively at boundary, normalize internally, serialize only supported shapes.

## WebSocket envelope

Top-level inbound messages include:

- `hello`
- `recording_state`
- `ping`
- `pong`
- `session`

Top-level outbound messages include:

- `pong`
- `status`
- `session`

Session messages wrap all rich daemon commands and events. The Rust server MUST preserve the existing wrapping behavior:

```json
{
  "type": "session",
  "message": { "type": "..." }
}
```

Do not replace this with raw event streams during migration.

## Handshake

Client sends:

```json
{
  "type": "hello",
  "clientId": "...",
  "clientType": "mobile|browser|cli|mcp",
  "protocolVersion": 1,
  "appVersion": "...",
  "capabilities": {}
}
```

Server responds with status payload:

```json
{
  "type": "status",
  "payload": {
    "status": "server_info",
    "serverId": "srv_...",
    "hostname": "...",
    "version": "...",
    "capabilities": {},
    "features": {}
  }
}
```

Rust MUST send `server_info` after accepting hello and before normal stream replay.

## Liveness

Current app uses JSON `ping`/`pong`, not RFC6455 protocol ping. Rust MUST keep this behavior because browser/React Native WebSocket APIs do not expose protocol ping portably.

Session RPC timeouts are operation failures, not proof that the socket is dead.

## Binary frames

Rust MUST preserve binary WebSocket framing for terminal streams.

Current layout from architecture doc:

- 1-byte opcode: output/input/resize/snapshot
- 1-byte slot
- variable payload

Terminal resize ownership rule remains: last genuinely interacting client wins. Passive render/attach events must not resize the PTY.

File transfer binary frames also live in protocol package and must be preserved before file upload/download parity is claimed.

## Required session RPC coverage

Rust parity requires these high-level groups from `messages.ts`:

### Agent lifecycle

- create agent
- resume agent
- import agent
- fetch/list agents
- fetch agent history
- fetch agent timeline
- send message
- wait for finish
- cancel/kill/archive/delete/close agents
- refresh agent
- set mode/model/thinking/feature
- rewind conversation/files/both
- clear attention

### Provider discovery

- list available providers
- list provider models
- list provider modes
- list provider features
- provider snapshots
- provider diagnostics
- recent provider sessions

### Permissions

- permission request events
- permission resolved events
- respond to permission
- pending permission list via MCP and UI path

### Workspaces and git

- fetch workspaces
- workspace updates
- open/archive workspace
- workspace setup status/progress
- checkout status/diff/commit/merge/pull/push/refresh
- PR create/merge/status/timeline
- branch suggestions, validation, switch/rename
- stash save/pop/list
- GitHub issue/PR search

### Worktrees

- create Rocky worktree
- list/archive worktrees
- setup commands and worktree bootstrap details

### Files

- file explorer
- project icon
- download token
- public/download endpoints

### Terminal and scripts

- list/create/rename/kill terminals
- subscribe/unsubscribe terminal
- terminal input/capture
- start workspace script
- script status updates

### Chat

- create/list/inspect/delete room
- post/read/wait messages
- mention fanout behavior

### Schedules and loops

- create/list/inspect/update/pause/resume/delete schedule
- schedule logs and run-once
- loop run/list/inspect/logs/stop

### Voice/dictation

- voice mode set
- dictation stream start/chunk/finish/cancel
- dictation ack/partial/final/error
- assistant audio/text messages
- audio played confirmations

If a subsystem is intentionally deferred, the Rust daemon must advertise a missing capability and the existing UI must show a clear unsupported state. Silent no-ops are forbidden.

## Agent timeline contract

Current `AgentTimelineItem` union includes:

- `user_message`
- `assistant_message`
- `reasoning`
- tool-call lifecycle items
- `todo`
- `error`
- `compaction`

Rust MUST preserve:

- daemon-owned canonical timestamps
- append-only rows
- sequence numbers for dedupe
- paged authoritative fetch
- live stream as immediacy only
- timeline replay after daemon restart

Tool call details must normalize provider output into existing variants:

- shell
- read
- edit
- write
- search
- fetch
- worktree setup
- to-do/plan where represented as timeline `todo`
- generic/unknown tool fallback

Do not drop provider-specific raw detail if current UI uses it.

## Storage root

`$ROCKY_HOME` defaults to `~/.rocky` and remains the only host data root.

Current important files/directories:

```text
$ROCKY_HOME/
  config.json
  server-id
  daemon-keypair.json
  rocky.pid
  daemon.log
  agents/{sanitized-cwd}/{agentId}.json
  schedules/{scheduleId}.json
  chat/rooms.json
  loops/loops.json
  projects/projects.json
  projects/workspaces.json
  push-tokens.json
  public/
  worktrees/
```

Rust MUST read existing data in place. It MUST NOT require users to export/import before cutover.

## Atomic writes

Persistent server stores SHOULD use atomic writes:

1. write temp file in target directory
2. fsync file where available
3. rename into place
4. fsync directory where available

Where current stores are not atomic (for example loop store docs mention direct serialized writes), Rust may improve them, but must preserve file format.

## Agent record schema

Path:

```text
$ROCKY_HOME/agents/{sanitized-cwd}/{agentId}.json
```

Current schema fields include:

- `id`
- `provider`
- `cwd`
- `createdAt`
- `updatedAt`
- `lastActivityAt?`
- `lastUserMessageAt?`
- `title?`
- `labels` default `{}`
- `lastStatus`
- `lastModeId?`
- `config?`
- `runtimeInfo?`
- `features?`
- `persistence?`
- `lastError?`
- `requiresAttention?`
- `attentionReason?`
- `attentionTimestamp?`
- `internal?`
- `archivedAt?`

Rust parser MUST accept missing optional fields and preserve unknown fields unless a migration explicitly owns them.

### Config subobject

Important persisted config fields:

- `modeId`
- `model`
- `thinkingOptionId`
- `featureValues`
- `extra`
- `systemPrompt`
- `mcpServers`

When resuming agents, Rust MUST refresh daemon-injected Rocky MCP server URLs. Do not persist stale boot-scoped `rockyToken` as authoritative.

### Persistence handle

Fields:

- `provider`
- `sessionId`
- `nativeHandle?`
- `metadata?`

Provider-specific native handles are opaque. Rust MUST not reinterpret or discard them unless the provider adapter owns the shape.

## Config contract

Path:

```text
$ROCKY_HOME/config.json
```

Current source uses `PersistedConfigSchema` with optional defaults and legacy normalization.

Rust MUST preserve at least:

- `daemon.listen`
- `daemon.hostnames` and legacy `allowedHosts`
- `daemon.mcp.enabled`
- `daemon.mcp.injectIntoAgents`
- `daemon.appendSystemPrompt`
- `daemon.teamAgents[]`
- `daemon.cors.allowedOrigins`
- `daemon.relay.enabled/endpoint/publicEndpoint/useTls/publicUseTls`
- `daemon.auth.password`
- `daemon.serviceProxy.publicBaseUrl/standaloneListen`
- `agents.providers` custom provider overrides
- `agents.metadataGeneration`
- speech/voice feature config
- `log` config
- `worktrees.root`
- `app.baseUrl`

Environment variables override persisted config as current `config.ts` does. CLI flags become env or explicit config overlay; do not create a third precedence order.

## Server identity and crypto

Rust MUST preserve:

- `server-id` format `srv_<base64url>`
- `ROCKY_SERVER_ID` override behavior if still present
- `daemon-keypair.json` v2 format
- relay pairing offer compatibility
- relay E2EE semantics

If Rust crypto implementation differs, add byte-level compatibility tests with existing Node-generated fixtures.

## Chat store

Path:

```text
$ROCKY_HOME/chat/rooms.json
```

Shape:

```json
{
  "rooms": [],
  "messages": []
}
```

Contracts:

- room names unique case-insensitively
- messages support `@mentions`
- `@everyone` fanout limit remains 25 unless config changes it
- wait operation resolves on new messages or timeout
- author agent id is required; CLI currently uses `ROCKY_AGENT_ID` or `manual`

## Schedule store

Path:

```text
$ROCKY_HOME/schedules/{scheduleId}.json
```

Contracts:

- supports `every` and `cron` cadence
- timezone is IANA when present, UTC when absent
- targets are existing agent or new-agent config
- startup must recover or finish stale running records consistently

## Loop store

Path:

```text
$ROCKY_HOME/loops/loops.json
```

Current docs say running loop records are recovered as stopped on daemon startup. Rust MUST preserve recovery semantics unless a migration explicitly upgrades them.

## Project and workspace registries

Paths:

```text
$ROCKY_HOME/projects/projects.json
$ROCKY_HOME/projects/workspaces.json
```

Contracts:

- active git projects unique by normalized root path
- startup reconciliation repairs duplicate path-keyed projects
- workspaces may be local checkout, worktree, or directory
- archived rows are soft-deleted with nullable `archivedAt`

## Mission store

New Rust-owned store:

```text
$ROCKY_HOME/missions/{missionId}.json
```

This store is additive. Existing clients must continue working if the directory is absent.

## HTTP endpoints

Preserve current route classes:

- `/` WebUI
- `/api/status` and daemon APIs
- `/ws`
- `/mcp/agents`
- `/download/...`
- `/public/...`
- service proxy routes by host

Endpoint auth behavior must match current server. WebUI is public; daemon actions are protected.

## MCP contract

The Rust MCP server MUST support both:

- top-level MCP sessions with no `callerAgentId`
- agent-scoped MCP sessions with `callerAgentId`

Agent-scoped behavior:

- validate parent agent exists
- default child cwd to parent cwd
- stamp `rocky.parent-agent-id` unless detached
- expose agent-scoped tools such as `speak` and `create_heartbeat` only when allowed
- inject current daemon MCP URL into created/resumed agents

Existing MCP tools listed in `mcp-server.ts` must remain unless replaced with compatible aliases.

## Error contract

Rust errors should map to existing client expectations:

- request/response failures use `rpc_error` where current server does
- provider unavailability returns provider diagnostic, not process panic
- auth failures remain HTTP 401/403 as current behavior
- invalid host header remains 403
- invalid input should identify the field and request id

Do not expose Rust backtraces to clients.

## Contract test strategy

Before cutover, build fixture suites:

1. Capture representative TS outbound messages and validate Rust can emit/parse the same JSON.
2. Capture representative client inbound messages and validate Rust accepts them.
3. Parse a copy of a real `$ROCKY_HOME` with Rust in read-only mode.
4. Round-trip agent records, config, chat, schedules, loops, project/workspace registries.
5. Run existing WebUI against Rust daemon without app code changes.
6. Run existing CLI against Rust daemon without CLI code changes.
7. Run MCP client against Rust `/mcp/agents` and compare tool list/behavior.

Rust parity is not claimed until these contract tests pass.
