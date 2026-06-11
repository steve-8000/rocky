# Rocky Rust Rebuild — Implementation Status

This document tracks the actual state of the Rust `rockyd` rebuild against the
phased plan in `core/docs/rust-rebuild/05-migration-and-verification.md`. It is
deliberately honest about what is done, verified, and still missing.

## Workspace layout (`rust/`)

| Crate | Responsibility | Phase |
|-------|----------------|-------|
| `rocky-config` | `$ROCKY_HOME` resolution, listen parsing, defaults | 1 |
| `rocky-store` | atomic writes, pid-lock, server-id, read-only `$ROCKY_HOME` projections (agents/chat/keypair/loops/registry/schedules) | 1, 3 |
| `rockyd` | binary: CLI, foreground daemon, singleton, signals, HTTP/WS, health/status, WebUI, mounts MCP | 1, 2, 8 |
| `rocky-agent-domain` | frozen wire/timeline boundary types (`AgentStreamEvent`, `AgentTimelineItem`, `ToolCallDetail`, permissions, status) | 4 |
| `rocky-acp` | ACP stdio JSON-RPC transport + session + tool/plan/permission mapping | 4 |
| `rocky-agents` | `AgentManager` state machine, timeline pipeline (persist-before-broadcast), permission queue, `prompt()` + event pump | 4 |
| `rocky-acp-provider` | bridges `rocky-acp` sessions to the `rocky-agents` provider trait (amaze) | 4, 8 |
| `rocky-mission-control` | file-backed Mission Control domain + board projection | 5 |
| `rocky-mcp` | MCP JSON-RPC server + mission/agent tool set, `/mcp/agents` router | 5 |
| `rocky-workspaces` | writable project/workspace registry, worktree lifecycle, git ops | 6 |
| `rocky-terminal` | terminal + file-transfer binary frame codec, PTY manager | 6 |
| `rocky-proxy` | service-proxy host classification + route registry | 6 |
| `rocky-scheduling` | schedule store/runner, cron, loop service + recovery | 7 |
| `rocky-relay` | NaCl-box E2EE crypto (tweetnacl-compatible), encrypted channel, pairing | 7 |
| `rocky-notify` | push token store, notification builder, speech capability gates | 7 |

## Verification status

- `cargo build` (workspace), `cargo clippy --all-targets`: clean (0 warnings).
- `cargo test` (workspace): 301 tests pass; 1 `#[ignore]` live ACP test +
  1 `#[ignore]` ACP-provider bridge test pass on demand against the real
  vendored amaze agent (`bun vendor/amaze/packages/coding-agent/src/cli.ts acp`).
- Live binary (temp `$ROCKY_HOME`, non-production port): `/api/health` 200,
  singleton lock enforced before bind, `daemon status/stop/restart` work,
  `/mcp/agents` serves `initialize` / `tools/list` (14 tools) /
  `create_mission` / `list_missions` end-to-end.
- Read-only parsers validated against a snapshot of the real `~/.rocky`
  (45 agents, 8 projects, 29 workspaces, chat, keypair, identical server-id).
- Relay crypto verified interoperable with tweetnacl (cross-impl decrypt both
  directions.
- Browser QA (headless Chrome + Playwright against the live Rust binary on a
  non-prod port with the real `core/packages/app/dist` bundle): the WebUI loads,
  connects over `/ws` to the Rust daemon, completes `hello → server_info`, and
  the on-load RPC suite round-trips (`client_heartbeat`,
  `get_providers_snapshot`, `fetch_workspaces`, `fetch_agents`). The Team
  (Mission Control) screen renders end-to-end — "Start a mission / Launch
  Leader" plus the Builder/Researcher/Reviewer/SRE roster from
  `get_daemon_config`. A full agent lifecycle (`create_agent` → real amaze ACP
  session → `send_agent_message` → `agent_stream` thread_started/turn_started/
  turn_completed pushed to the socket) succeeds against the same binary.

## Phases 1–7: complete and verified per their acceptance criteria.

## Phase 8 (cutover): partial — intentionally NOT switched in production.

Done and non-destructive:
- The Rust binary now mounts the agent + mission MCP surface at `/mcp/agents`
  and drives real amaze ACP sessions through `AgentManager`.
- Opt-in launch script `scripts/rockyd-rust.sh` (does not change the default
  `scripts/rockyd.sh` path).
- Idempotent `scripts/cleanup-stale-launchd.sh` to disable the known stale
  duplicate label `one.clab.rocky.rockyd` (guards the canonical
  `one.clab.rocky`). Not auto-executed.

### Phase 9 — WS session RPC bridge (added)

The production WebUI/app talks to the daemon over the `/ws` WebSocket using the
wrapped **session RPC** protocol (`core/packages/server/src/server/session.ts`,
~9.4k lines, 122 distinct request types). The `rocky-ws-session` crate now
implements this:
- `SessionDispatcher` + `{type:"session", message:{...}}` envelope wrap/unwrap.
- Handler groups backed by the existing Rust crates:
  - mission (`mission.*`) → `rocky-mission-control`
  - agent lifecycle (`fetch_agents`/`fetch_agent`/`fetch_agent_timeline`/
    `cancel`/`archive`/`delete`/`clear_attention`/`send`/`wait`/config) →
    `rocky-agents`
  - workspace/git/worktree/terminal control → `rocky-workspaces` +
    `rocky-terminal`
  - chat/schedule/loop → file-backed chat store + `rocky-scheduling`
- Mounted on the binary's `/ws`: after `hello`/`server_info`, inbound session
  envelopes are dispatched and wrapped responses sent back.

Verified live: the release binary on a non-prod port + temp `$ROCKY_HOME`
answers `hello → server_info`, then `mission.create.request` →
`mission.create.response` (`mis_...`), then `mission.list.request` shows it.
The `scripts/smoke.sh` contract (UI root, brand, SPA fallback, API health)
passes against the Rust binary with the real `core/packages/app/dist` bundle,
plus `/mcp/agents` exposing 14 tools.

### Remaining gap before production cutover (honest)

The session RPC bridge now covers agent lifecycle (incl. LIVE `create_agent` /
`send_agent_message` via the wired amaze ACP provider + `agent_stream` push),
mission control, workspace/git/worktree/terminal control, chat/schedule/loop,
the on-load read RPCs (daemon config/status, providers snapshot, heartbeat,
push token, project config), checkout/git/stash, and files/explorer. Still NOT
covered out of the full 122-message surface (return structured "not wired"
errors, never fake success):
- GitHub PR/merge/auto-merge/search RPCs (need the `gh` CLI / GitHub API),
- rich provider model/mode discovery beyond structural availability,
- dictation/voice streaming RPCs (capability-gated as unsupported),
- binary terminal STREAM frame piping (JSON terminal control messages are
  handled; raw output/input frame relay must be wired at the WS transport),
- config mutation RPCs that require durable storage writers (`update_agent`
  name/labels) or provider features (`set_agent_feature`). The live provider
  config selectors — `set_agent_model` / `set_agent_thinking` / `set_agent_mode`
  — ARE wired: they drive `session/set_config_option` on the live ACP session
  and broadcast the matching `*_changed` stream event. A session-less (hydrated
  or closed) agent returns a precise "no live session; resume it" error.

Because of this partial coverage AND live/idle agents on the production daemon,
production cutover is **intentionally not executed**. Per the user constraints
("do not break Mission Control continuity"; live restart interrupts active
agents), the canonical daemon (`one.clab.rocky`, port 7767) is left running on
the TypeScript supervisor.

### Cutover artifacts (ready, not executed)
- `scripts/rockyd-rust.sh` — opt-in Rust launch entrypoint.
- `scripts/cleanup-stale-launchd.sh` — disables the stale `one.clab.rocky.rockyd`.
- `scripts/cutover-to-rust.sh` — guarded production cutover runbook (backup +
  manual launchd repoint + rollback); refuses to run without `CONFIRM=yes`.

### To reach full production cutover
1. Finish the remaining WS session RPC groups (provider snapshot, checkout/PR,
   files, voice, binary terminal frame piping) and wire the live provider into
   the WS agent create/send path.
2. Run the full `scripts/smoke.sh` (including the agent run) against the Rust
   binary.
3. With user consent for agent interruption, run `scripts/cutover-to-rust.sh`
   (`CONFIRM=yes`), verify, then remove the TS daemon entrypoints
   (`server/rockyd.ts`, `supervisor-entrypoint.ts`, `supervisor.ts`,
   `daemon-worker.ts`) or reduce them to shims that exec the Rust binary.