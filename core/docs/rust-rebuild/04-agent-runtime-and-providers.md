# 04 — Agent Runtime and Providers

## Goal

The Rust daemon must preserve Rocky's agent control plane while moving daemon ownership, state management, protocol serving, and provider orchestration into Rust.

Agent providers themselves remain external runtimes or protocol adapters during the rebuild. Do not rewrite Claude, Codex, OpenCode, Pi, Copilot, or vendored amaze as Rust agents as part of host daemon parity.

## Current source facts

Provider contract lives in:

- `core/packages/server/src/server/agent/agent-sdk-types.ts`
- `core/packages/server/src/server/agent/agent-manager.ts`
- `core/packages/server/src/server/agent/providers/*`

Important current provider types:

- `AgentClient`
- `AgentSession`
- `AgentSessionConfig`
- `AgentRunResult`
- `AgentStreamEvent`
- `AgentTimelineItem`
- `AgentPermissionRequest`
- `AgentPermissionResponse`
- `AgentPersistenceHandle`

Current providers include:

- Claude Code SDK
- Codex AppServer
- OpenCode
- Copilot ACP
- Cursor ACP
- Generic ACP
- Pi
- mock/load-test providers
- vendored amaze through generic/custom ACP config

## Final provider architecture

Rust daemon owns provider lifecycle through a Rust trait equivalent of `AgentClient`:

```rust
trait AgentProviderClient {
    fn provider_id(&self) -> &str;
    async fn is_available(&self) -> ProviderAvailability;
    async fn list_models(&self, cwd: &Path, force: bool) -> Result<Vec<ModelDefinition>>;
    async fn list_modes(&self, cwd: &Path, force: bool) -> Result<Vec<AgentMode>>;
    async fn list_features(&self, config: &AgentSessionConfig) -> Result<Vec<AgentFeature>>;
    async fn create_session(
        &self,
        config: AgentSessionConfig,
        launch: AgentLaunchContext,
        options: CreateSessionOptions,
    ) -> Result<Box<dyn AgentSession>>;
    async fn resume_session(
        &self,
        handle: AgentPersistenceHandle,
        overrides: AgentSessionConfigPatch,
        launch: AgentLaunchContext,
    ) -> Result<Box<dyn AgentSession>>;
    async fn list_persisted_agents(&self, options: ListPersistedAgentsOptions) -> Result<Vec<PersistedAgentDescriptor>>;
    async fn shutdown(&self) -> Result<()>;
}
```

`AgentSession` equivalent must support:

- run prompt
- start turn
- subscribe to stream events
- stream history
- runtime info
- modes/models/features mutation
- pending permissions
- respond to permission
- describe persistence
- interrupt
- close
- list slash commands
- rewind conversation/files/both where supported
- out-of-band prompt handling where supported

## ACP first

The Rust rebuild should implement ACP provider support before native SDK-specific providers because vendored amaze and multiple current providers already use ACP.

ACP support must include:

- stdio subprocess launch
- environment overlay
- working directory handling
- JSON-RPC framing
- session create/resume
- model/mode discovery
- tool call lifecycle mapping
- plan/todo mapping into Rocky timeline `todo`
- permission request/response mapping
- session persistence handles
- graceful child shutdown and kill timeout

Vendored amaze command from `config/rocky.config.json`:

```json
["bun", "__ROCKY_ROOT__/vendor/amaze/packages/coding-agent/src/cli.ts", "acp"]
```

Rust must expand `__ROCKY_ROOT__` exactly as setup/config currently does.

## Generic ACP provider

Current generic ACP provider has important Rocky-specific behavior:

- advertises a synthetic `bypass` mode when the provider does not expose an unattended mode
- normalizes approval aliases such as `never`, `bypassPermissions`, `full-access`, `allow-all`
- handles autonomous approval inside Rocky, not by forwarding unsupported modes to the provider

Rust MUST preserve this because team agents in `config/rocky.config.json` rely on `approvalPolicy: "never"`.

## Agent lifecycle state machine

Preserve current states:

```text
initializing -> idle <-> running
          \       \       \
           \       \       -> error
            \       -> error
             -> error
error -> closed
idle/running -> closed
```

Definitions:

- `initializing`: provider session being created
- `idle`: live session exists and is ready for prompt
- `running`: provider currently producing a turn
- `error`: session exists but last operation failed
- `closed`: terminal state

AgentManager remains the source of truth for state and broadcasts updates to subscribers.

## Agent creation

Rust must preserve current create flow from `create-agent/create.ts`:

1. Resolve requested provider/model.
2. Resolve cwd:
   - top-level agents use requested cwd or process cwd
   - agent-scoped MCP children default relative to parent cwd
   - caller context may lock cwd or disallow custom cwd
3. Optionally create worktree.
4. Resolve mode/features through provider snapshot manager.
5. Apply unattended/approval policy.
6. Merge labels:
   - parent label when callerAgentId exists and not detached
   - caller context default labels
   - user labels
7. Create ManagedAgent record.
8. Create provider session.
9. Inject Rocky MCP server if enabled.
10. Persist config/runtime/persistence.
11. Start initial prompt if provided.
12. Schedule metadata generation.
13. Broadcast agent updates and stream events.

## MCP injection

Current behavior:

- If `mcpInjectIntoAgents` is enabled, daemon injects a `rocky` MCP server into agent config.
- URL includes current daemon `/mcp/agents` endpoint and `callerAgentId=<agentId>`.
- If auth/password is enabled, URL also includes boot-scoped `rockyToken`.
- The full URL can be persisted in agent config.
- On resume/reload, server must refresh that injected entry to avoid stale token 401s.

Rust MUST preserve the marker rule:

- `callerAgentId=` identifies daemon-injected Rocky MCP config.
- User-provided Rocky MCP configs without `callerAgentId` are left untouched.
- If injection disabled, stale injected config is dropped.

## Timeline pipeline

Provider events become durable timeline rows and live stream events.

Rust pipeline:

```text
provider event
  -> normalize to AgentStreamEvent
  -> attach daemon timestamp/turn/epoch
  -> update live ManagedAgent state
  -> append persisted timeline row with sequence number
  -> broadcast to subscribed sessions
  -> update attention/notification state if needed
```

Required event categories:

- thread started
- turn started/completed/canceled
- usage updated
- timeline item
- permission requested/resolved
- mode/model changed
- compaction
- error

Do not broadcast before persistence unless a subsystem explicitly tolerates replay loss.

## Tool-call mapping

Rust must preserve normalized `ToolCallDetail` semantics used by UI:

- shell command, cwd, output, exit code
- read file path/content/ranges
- edit old/new/unified diff
- write file path/content
- search query/results/counts/truncation
- fetch URL/result/status
- worktree setup details
- voice/speech actions where present
- generic unknown fallback with title/kind/status/content

Provider-specific mapper parity is mandatory before a provider is marked supported.

## Todo/plan mapping

Amaze ACP currently maps `todo_write` results to ACP plan updates. Rocky maps plan updates to timeline `todo` entries.

Rust MUST ensure:

- non-empty plan entries become `AgentTimelineItem::Todo`
- empty plan updates clear or suppress the visible todo card, not create a permanent "No tasks yet" card
- abandoned tasks map consistently to completed/hidden based on existing UI expectations until a protocol extension is added

## Permissions

Rust permission queue must preserve:

- request id
- agent id
- kind: tool/plan/question/mode/other
- title/description/input/detail
- suggestions/actions
- metadata
- allow/deny responses
- deny interrupt behavior
- follow-up prompt behavior when provider needs it

Permission requests must be:

- persisted or recoverable enough to survive client reconnects
- broadcast to all subscribed clients
- available through MCP `list_pending_permissions`
- resolvable through MCP `respond_to_permission`
- attached to Mission Control task context when applicable

## Provider snapshots

Current ProviderSnapshotManager caches provider availability/models/modes/features. Rust must preserve:

- provider status: ready/loading/error/unavailable
- provider label/description
- model list with thinking options and defaults
- mode list and default mode
- dynamic refresh
- diagnostics
- generic/custom provider overrides from config

Mode resolution must remain provider-aware and support parent/unattended context.

## Resume and reload

Rust must support:

- resume from Rocky agent record
- resume from provider-native session descriptors
- reload provider session for an existing record
- preserve timeline
- refresh injected MCP config
- update runtime info
- recover live status after daemon restart

On startup, stored `running` agents must not be falsely treated as still running unless the provider session is actually live. Use current recovery behavior as baseline and document any change.

## Rewind

Current provider interface supports optional:

- `revertConversation`
- `revertFiles`
- `revertBoth`

Rust must gate rewind actions by provider capability flags and preserve response shapes.

## Cancellation and killing

Definitions:

- cancel: ask provider/session to interrupt current turn
- kill: close session and terminate provider process if applicable
- archive: soft-delete Rocky record and best-effort archive native provider session
- delete: remove record only where current semantics allow

Rust process manager must distinguish graceful close, interrupt, and force kill.

## Provider subprocess management

For every subprocess-backed provider:

- set cwd intentionally
- set env intentionally
- include `ROCKY_AGENT_ID` for chat author attribution where applicable
- stream stdout/stderr into provider logs or daemon trace with redaction
- enforce startup timeout
- enforce shutdown timeout
- kill process group where platform supports it
- avoid leaking child processes on daemon crash/shutdown

## Sandboxing and approval policies

Rust must preserve config fields:

- `approvalPolicy`
- `sandboxMode`
- `networkAccess`
- `webSearch`
- provider-specific `featureValues`

Mapping is provider-specific. Do not assume all providers understand the same strings.

## Metadata generation

Current daemon schedules metadata generation for titles, branch names, commit/PR text, etc. Rust must preserve:

- configured provider fallback order from `agents.metadataGeneration.providers`
- current selection fallback
- provider snapshot availability checks
- internal agent behavior hidden from user lists
- no notification spam for internal agents

## Speech and voice agents

If speech/voice remains in Rust parity scope, preserve:

- STT/TTS config
- voice mode capability advertisement
- dictation stream protocol
- hidden voice tools like `speak` only for voice-enabled agent-scoped sessions
- local speech model paths and worker process behavior

If deferred, advertise capability absence cleanly and keep app behavior safe.

## Acceptance criteria

Agent runtime parity is complete when:

- Existing vendored amaze provider can create, run, stream, request permissions, use Rocky MCP tools, and resume.
- A Leader can spawn Teammates through injected MCP and the children receive parent labels.
- Provider models/modes/features are listed through existing UI/CLI without app changes.
- Permission prompts work from app and MCP.
- Agent timeline replay after daemon restart matches persisted rows.
- Provider subprocesses do not leak after daemon shutdown or crash.
- Stale injected `rockyToken` URLs are refreshed on resume/reload.
- Existing e2e tests for agent create/send/wait/import/resume/rewind can be ported or run against Rust daemon.
