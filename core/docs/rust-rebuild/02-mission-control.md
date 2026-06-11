# 02 — Mission Control Domain

## Goal

Mission Control is Rocky's first-class multi-agent orchestration domain. It replaces today's loose combination of Team screen, `rocky-orchestrate` skill instructions, daemon MCP tools, chat rooms, worktrees, parent labels, and `TEAM_BOARD.md` convention with an explicit daemon-backed model.

The Rust daemon MUST preserve the current Leader/Teammate behavior while making missions observable, durable, and testable.

## Current source facts

Current Mission Control behavior is spread across source:

- `skills/rocky-orchestrate/SKILL.md`
  - defines Leader/Teammate protocol
  - uses one chat room per mission as mailbox
  - uses `TEAM_BOARD.md` as shared board
  - uses Rocky MCP tools to create/wait/send/cancel/archive agents
  - recommends worktrees by default for code-changing Teammates
- `core/packages/app/src/screens/team-screen.tsx`
  - "Start a mission" UI
  - chooses a project
  - builds a Leader draft and routes to new workspace/agent flow
- `core/packages/app/src/screens/team-model.ts`
  - `buildLeaderBriefing()` embeds the orchestration protocol and registered team agent roster
  - `groupAgentsIntoTeams()` groups agents by parent label
- `core/packages/protocol/src/agent-labels.ts`
  - parent label key is `rocky.parent-agent-id`
- `core/packages/server/src/server/agent/create-agent/create.ts`
  - `create_agent` via MCP stamps child agents with `rocky.parent-agent-id` unless `detached: true`
  - child cwd defaults relative to parent, supports worktree creation
- `core/packages/server/src/server/agent/mcp-server.ts`
  - exposes `create_agent`, `wait_for_agent`, `send_agent_prompt`, `get_agent_status`, `list_agents`, `cancel_agent`, `kill_agent`, `archive_agent`, `create_worktree`, permission tools, provider tools, terminal tools, schedule tools
- `core/packages/server/src/server/chat/chat-service.ts`
  - persists chat rooms/messages under `$ROCKY_HOME/chat/rooms.json`
  - supports mentions and wait semantics
- `config/rocky.config.json`
  - defines reusable `daemon.teamAgents[]` roster entries such as Builder, Researcher, Reviewer, SRE

## Domain vocabulary

### Mission

A user-intent container for one coordinated multi-agent effort.

Required fields:

```json
{
  "id": "mis_<id>",
  "goal": "Ship the feature",
  "status": "draft|running|blocked|verifying|completed|failed|canceled|archived",
  "projectId": "...",
  "workspaceId": "...",
  "leaderAgentId": "...",
  "chatRoomId": "...",
  "boardPath": "/repo/TEAM_BOARD.md",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "completedAt": "ISO|null",
  "archivedAt": "ISO|null"
}
```

### Leader

The primary daemon agent for a mission. The Leader decomposes work, creates Teammates, monitors them, integrates results, runs verification, and reports.

Current source creates a Leader by drafting the `buildLeaderBriefing()` prompt into the normal agent creation flow. Final Rust daemon may still use a normal agent as Leader, but the mission record MUST explicitly point to it.

### Teammate

A daemon agent created by a Leader for a mission subtask. A Teammate is linked by:

- `missionId`
- `leaderAgentId`
- existing compatibility label `rocky.parent-agent-id = leaderAgentId`
- optional task/board row id
- optional worktree id/path

For compatibility, the parent label MUST remain until all clients migrate to mission-native grouping.

### Board

The work breakdown and status surface. Current source uses `TEAM_BOARD.md` with rows:

```markdown
| # | Task | Owner (agent id) | Isolation | Status | Result |
```

Rust Mission Control MUST support this file for compatibility, but the daemon should also maintain a structured board model.

### Mailbox

A chat room used for mission coordination. Current skill says every Teammate prompt MUST end with a summary-to-chat instruction. Final Rust Mission Control MUST create and bind the room explicitly.

### Roster

Reusable team presets from `daemon.teamAgents[]`.

Current schema in protocol `TeamAgentSchema` includes:

- `id`
- `name`
- `role`
- `provider`
- `model?`
- `thinkingOptionId?`
- `approvalPolicy?`
- `systemPrompt?`
- `enabled?`

Mission Control MUST use this roster when launching Teammates and MUST preserve the settings UI contract.

## Mission state machine

```text
draft
  -> running
running
  -> blocked
  -> verifying
  -> failed
  -> canceled
blocked
  -> running
  -> failed
  -> canceled
verifying
  -> running      (integration fallout)
  -> completed
  -> failed
completed
  -> archived
failed
  -> archived
canceled
  -> archived
```

Rules:

- A mission enters `running` when the Leader agent is created and initial prompt starts.
- A mission enters `blocked` when any active task is blocked and no automated progress is possible.
- A mission enters `verifying` when all Teammate rows are done and integration/verification starts.
- A mission enters `completed` only after verification evidence is attached.
- A mission enters `archived` only after finished agents are archived or intentionally retained.

## Board data model

Structured board file under `$ROCKY_HOME/missions/{missionId}.json`:

```json
{
  "version": 1,
  "id": "mis_...",
  "goal": "...",
  "status": "running",
  "leaderAgentId": "...",
  "chatRoomId": "...",
  "workspaceId": "...",
  "boardPath": "/repo/TEAM_BOARD.md",
  "tasks": [
    {
      "id": "task_...",
      "title": "Implement API",
      "description": "...",
      "acceptanceCriteria": ["..."],
      "status": "todo|running|blocked|failed|done|canceled",
      "ownerAgentId": "...",
      "rosterAgentId": "tagent_builder",
      "worktreePath": "...",
      "isolation": "shared|worktree|read-only",
      "result": "...",
      "verification": [
        {
          "kind": "command|manual|agent|test",
          "summary": "...",
          "evidence": "...",
          "passed": true,
          "timestamp": "ISO"
        }
      ],
      "createdAt": "ISO",
      "updatedAt": "ISO"
    }
  ],
  "events": [
    {
      "seq": 1,
      "timestamp": "ISO",
      "type": "mission_started|task_created|agent_assigned|task_status_changed|chat_posted|permission_requested|permission_resolved|verification_added|mission_completed",
      "payload": {}
    }
  ]
}
```

The structured board is authoritative for the daemon and UI. `TEAM_BOARD.md` is a human-readable projection and compatibility surface.

## `TEAM_BOARD.md` compatibility

Rust daemon MUST preserve this behavior:

- Mission root contains `TEAM_BOARD.md` unless explicitly disabled.
- The file is updated after every task state change.
- Human edits should not be blindly overwritten. When conflict is detected, record a mission event and ask the Leader or human to reconcile.

Minimum generated shape:

```markdown
# Team Board — <goal>

| #   | Task | Owner (agent id) | Isolation | Status | Result |
| --- | ---- | ---------------- | --------- | ------ | ------ |
```

Status vocabulary remains `todo / running / blocked / failed / done` for compatibility with current skill.

## Mailbox requirements

Mission Control MUST create or bind exactly one chat room per mission.

Chat room naming recommendation:

```text
mission-<short-id>-<slug>
```

Every Teammate prompt MUST include:

```text
When finished or blocked, post a 1-3 line summary to chat room <room-id-or-name> and stop.
```

Daemon SHOULD also support native finish notifications so Mission Control does not rely only on the agent following instructions. Current source has `setupFinishNotification()` for agent-to-agent created children; preserve this behavior.

## Worktree policy

Current skill rule:

- Worktrees are default for code-changing Teammates.
- Shared workspace is acceptable only for read-mostly or documentation tasks.
- Never run two Teammates with write access to the same files without worktrees.

Rust Mission Control MUST enforce this at mission/task creation time:

- Task has `isolation`.
- If `isolation = shared`, task must be declared read-only or doc-only, or user must explicitly override.
- If two running tasks write overlapping file globs in shared mode, block the second task.
- Worktree creation uses the existing semantics of `create_worktree` / `CreateRockyWorktreeRequest`.

## Permission model

Current source exposes permission queue through daemon and MCP tools:

- `list_pending_permissions`
- `respond_to_permission`
- app permission prompts
- provider-specific permission requests normalized into `AgentPermissionRequest`

Mission Control MUST:

- attach permission requests to mission/task/agent context
- show whether the request came from Leader or Teammate
- allow approve/deny with scoped context
- deny anything outside task scope by default in autonomous mission mode
- record permission events in mission event log

Team presets with `approvalPolicy: "never"` are allowed only when explicitly configured in roster or mission settings.

## Agent labels and grouping

For backward compatibility, every non-detached Teammate MUST still receive:

```json
{
  "labels": {
    "rocky.parent-agent-id": "<leaderAgentId>"
  }
}
```

New labels should be added:

```json
{
  "rocky.mission-id": "mis_...",
  "rocky.mission-task-id": "task_...",
  "rocky.role": "leader|teammate"
}
```

Existing app grouping by parent label must keep working until app migrates to mission-native APIs.

## Mission APIs

Rust daemon should expose mission-native APIs over WebSocket and optionally HTTP.

Required request/response pairs:

- `mission.create.request` / `mission.create.response`
- `mission.list.request` / `mission.list.response`
- `mission.inspect.request` / `mission.inspect.response`
- `mission.update.request` / `mission.update.response`
- `mission.cancel.request` / `mission.cancel.response`
- `mission.archive.request` / `mission.archive.response`
- `mission.task.create.request` / `mission.task.create.response`
- `mission.task.update.request` / `mission.task.update.response`
- `mission.task.assign_agent.request` / `mission.task.assign_agent.response`
- `mission.verify.request` / `mission.verify.response`

Events:

- `mission_update`
- `mission_task_update`
- `mission_event`

Follow existing RPC naming convention from `core/docs/rpc-namespacing.md`: dotted namespace plus `.request`/`.response`.

## MCP tools for Mission Control

Existing MCP tools remain available. New mission-native tools should be layered on top:

- `create_mission`
- `inspect_mission`
- `list_missions`
- `create_mission_task`
- `assign_mission_task`
- `update_mission_task`
- `post_mission_update`
- `complete_mission_task`
- `request_mission_verification`

Tool behavior MUST still be expressible through existing lower-level tools for compatibility. Mission-native tools are the preferred surface for new agents.

## Leader briefing generation

Current `buildLeaderBriefing()` contract must be preserved:

- identifies the agent as Leader
- instructs use of `rocky-orchestrate`
- forbids built-in task/subagent tools for Teammates
- says only daemon agents appear on Team board
- requires worktrees for code changes
- requires `TEAM_BOARD.md`
- embeds registered team agents and their provider/model/thinking/approval policy/system prompt
- includes the user goal

Rust Mission Control may generate this briefing server-side, but the text must remain equivalent until the app migrates.

## UI requirements

The app currently has a Team screen. The Rust daemon should make it Mission Control without breaking current views.

Required views:

- Start mission: goal, project/workspace, roster selection, isolation policy.
- Active missions list: status, leader, teammates, latest activity, blocked permissions.
- Mission detail: board, chat/mailbox, agents, worktrees, permissions, verification evidence.
- Task detail: owner, prompt, acceptance criteria, files/worktree, timeline link, result.
- Archive controls: archive mission and optionally archive all agents/worktrees.

Existing Team grouping by `rocky.parent-agent-id` remains a fallback.

## Persistence

Mission records live under:

```text
$ROCKY_HOME/missions/{missionId}.json
```

Use atomic temp-file + rename writes.

Indexes may be added later, but initial implementation can list mission files by directory scan if bounded. Do not put mission state into agent records only; missions are first-class.

## Notifications

Mission Control SHOULD send notifications for:

- mission blocked
- Teammate finished
- permission requested
- verification failed
- mission completed

Notification routing reuses existing push token store and agent attention mechanisms where possible.

## Acceptance criteria

Mission Control is complete when:

- Starting a mission creates a durable mission record, Leader agent, chat room, and board.
- Leader-created Teammates are linked by mission id and parent label.
- Existing Team screen grouping still works.
- Mission detail can be reconstructed after daemon restart from `$ROCKY_HOME` only.
- Permissions show mission/task context.
- Worktree isolation is enforced for parallel writing tasks.
- A completed mission records verification evidence before entering `completed`.
- Finished mission archival archives or intentionally retains all related agents and worktrees.
