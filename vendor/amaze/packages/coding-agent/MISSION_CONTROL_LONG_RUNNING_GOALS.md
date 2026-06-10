# Mission Control Long-Running Goals Architecture

## Purpose

Make Amaze Mission Control capable of carrying a mission across many autonomous turns until the mission is completed, blocked, cancelled, paused by the user, or stopped by an explicit budget/policy limit. The target behavior is equivalent to Codex goals: an active objective is persisted, resumed after session/process boundaries, and continued automatically when the agent becomes idle.

## Current gap

Mission Control currently records and projects mission state; it does not own the continuation loop.

Evidence in the current implementation:

- `MissionControlRuntime.ensureActiveMission()` creates or reuses a mission and moves it to `planning` or `executing`, but it does not schedule another turn.
- `MissionRuntime.markLifecycle()` is explicitly bookkeeping for the interactive hot path; the LLM agent loop performs the actual work.
- `MissionControlRuntime.getActiveMission()` clears the active pointer when a mission reaches `completed`, `cancelled`, or `blocked`.
- `streamMissionEvents()` is an event reader with a default idle timeout, not a mission runner.
- `autoresearch/index.ts` already demonstrates the required continuation mechanism: on `agent_end`, if the mode is active and no user message is pending, it calls `api.sendMessage(..., { deliverAs: "nextTurn", triggerTurn: true })`.

Codex differs because its goal runtime persists the active goal, restores it on resume, and starts a new task when the active goal is idle. Amaze should adopt that lifecycle pattern for Mission Control instead of adding another parallel orchestration system.

## Normative decisions

These are fixed for implementation:

1. `paused`, `waiting_for_approval`, and `budget_limited` are continuation-ledger statuses, not mission lifecycle states.
2. The mission lifecycle source remains `MissionRuntime`/`MissionStore`; the continuation runtime must not create a second lifecycle enum.
3. The continuation runtime never fabricates a `MissionOutcome` and never calls `MissionRuntime.complete()` from `agent_end` unless the agent has already supplied a real outcome through the existing completion path.
4. Automatic completion remains the agent's responsibility. The continuation runtime runs an acceptance preflight with the same semantics as `MissionRuntime.complete()` and decides whether to continue, wait, or stop.
5. The continuation ledger primary key is `missionId`; `sessionId` is metadata for the last owner/toucher.
6. Branch/fork handling is ownership-based: the first ledger owner keeps continuation rights. A different branch/session may observe the mission but must not schedule unless it acquires ownership through an explicit select/resume command or a compare-and-swap ownership transfer.
7. Automatic continuation is enabled in interactive/TUI sessions, enabled in ACP only when the host allows agent-initiated turns, and disabled in one-shot print/non-interactive runs.

## Design principles

1. Mission Control is the single source of truth for long-running work.
2. A mission is not complete because a turn ended; it is complete only when the shared acceptance policy says completion is allowed and the existing completion path records a real outcome.
3. Continuation is a runtime policy layered on top of persisted mission state, not a prompt-only convention.
4. User intent has priority. Pending user messages pause automatic continuation until the user input is handled.
5. Every automatic continuation must be attributable, observable, replayable, and bounded by explicit stop conditions.
6. Terminal states are sticky. `completed`, `blocked`, and `cancelled` never auto-resume.
7. Continuation-paused missions remain persisted but never schedule continuation turns.
8. The design must survive session switches, compaction, process restart, and host mode differences where agent-initiated turns are supported.

## Target behavior

When a mission is active and not terminal:

1. At session start/switch, Mission Control rehydrates the persisted mission and evaluates whether a continuation should start without waiting for a new user prompt.
2. At the end of an agent turn, Mission Control evaluates the persisted mission.
3. If the mission was completed through the existing mission completion path, Mission Control marks continuation completed and stops.
4. If acceptance preflight passes but no real completion outcome exists, Mission Control schedules a continuation turn instructing the agent to record the outcome through Mission Control.
5. If the mission is blocked, cancelled, continuation-paused, over budget, awaiting approval, or awaiting the user, it records the reason and stops scheduling.
6. If the mission is still executable and no user message is pending, Mission Control injects a hidden continuation message as the next turn.
7. The next turn receives a concise mission context: objective, current lifecycle, last outcome, acceptance gates, incomplete phases, verification requirements, and allowed next action.
8. The loop repeats until a terminal state or explicit pause/limit.

## High-level architecture

```text
AgentSession / Extension events
        │
        ▼
Mission Continuation Extension
        │
        ├── session_start/session_switch ─► rehydrate persisted mission
        │                                  cold-start eligible continuation
        │
        ├── before_agent_start ──────────► reconcile ledger generation
        │                                  inject mission context
        │
        ├── agent_end ───────────────────► evaluate persisted mission
        │                                  complete-state observe / pause / block / continue
        │                                  CAS schedule hidden nextTurn
        │
        └── session_shutdown ────────────► clear in-memory runtime only
                                           persisted mission remains authoritative

MissionContinuationRuntime
        │
        ├── MissionControlRuntime / MissionRuntime acceptance preflight
        ├── MissionStore / MissionReadModel
        ├── continuation ledger with CAS transitions
        └── continuation prompt renderer
```

## New modules

### `packages/coding-agent/src/mission/continuation/index.ts`

Registers extension hooks and delegates policy decisions to the runtime.

Responsibilities:

- Subscribe to `session_start`, `session_switch`, `session_branch`, `session_tree`, `before_agent_start`, `agent_end`, and `session_shutdown`.
- On `session_start` and resumptive `session_switch`, evaluate cold-start continuation after the host reports the UI/session is idle; do not preempt the user's first input opportunity.
- Keep only session-local transient data in memory.
- Never treat memory as authoritative for mission lifecycle.
- Call `api.sendMessage()` with `deliverAs: "nextTurn"` and `triggerTurn: true` only after the persisted mission is found eligible and the ledger CAS succeeds.
- Re-check `ctx.hasPendingMessages()` immediately before the final `api.sendMessage()` call.
- Never schedule for terminal missions or continuation-paused missions.

### `packages/coding-agent/src/mission/continuation/runtime.ts`

Owns the long-running mission policy.

Core API:

```ts
export interface MissionContinuationRuntime {
  rehydrate(ctx: ExtensionContext): Promise<void>;
  onSessionAvailable(ctx: ExtensionContext): Promise<void>;
  beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined>;
  afterAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): Promise<void>;
  clearSession(ctx: ExtensionContext): void;
}
```

The implementation uses smaller pure functions for testability:

```ts
export function classifyContinuation(input: ContinuationDecisionInput): ContinuationDecision;
export function buildMissionContinuationPrompt(input: MissionContinuationPromptInput): string;
export function selectContinuableMission(input: SelectContinuableMissionInput): MissionView | undefined;
export function buildAcceptancePreflight(input: MissionView): MissionAcceptancePreflight;
```

On rehydrate, if the runtime finds an owned, non-terminal continuation row, it must restore the in-memory active mission pointer in `MissionControlRuntime` before any command or prompt reads active mission state. The durable identity is the ledger row; the runtime pointer is a cache for current-session ergonomics.

### `packages/coding-agent/src/mission/continuation/prompt.md`

The hidden continuation message. It must be deterministic, compact, and operational.

Required sections:

- Mission objective.
- Current lifecycle and active phase.
- Acceptance gates still unsatisfied.
- Last turn summary and verification status.
- Hard stop conditions.
- Instruction to continue the next smallest safe step.
- Instruction to record Mission Control completion only after verification passes and a real outcome summary exists.

The prompt must not ask the model to pretend the mission is complete. It must explicitly tell the model to mark blocked if a real prerequisite is missing.

### `packages/coding-agent/src/mission/continuation/ledger.ts`

Persists continuation scheduling metadata so restarts and duplicate events cannot cause runaway duplicate turns.

The primary key is `missionId`. `sessionId`, branch, and tree data are ownership metadata, not identity.

Suggested table or MissionStore-backed record:

```ts
export interface MissionContinuationRecord {
  missionId: string;
  sessionId: string;
  ownerBranch: string | null;
  ownerTreeId: string | null;
  status: "idle" | "scheduled" | "running" | "paused" | "waiting_for_approval" | "blocked" | "completed" | "budget_limited";
  generation: number;
  lastScheduledAt: number | null;
  lastStartedAt: number | null;
  lastEndedAt: number | null;
  lastTurnId: string | null;
  lastReason: string | null;
  autoTurnCount: number;
  tokenEstimateUsed: number | null;
  progressFingerprint: string | null;
  noProgressCount: number;
  updatedAt: number;
}
```

Required compare-and-swap transitions:

- `scheduleNext(missionId, expectedGeneration)` succeeds only when the row is `idle` at `generation = expectedGeneration`; it writes `status = "scheduled"` and `generation = expectedGeneration + 1`.
- `markRunning(missionId, generation)` succeeds only when the row is `scheduled` at the same generation.
- `markIdleAfterEnd(missionId, generation)` succeeds only when the row is `running` at the same generation.
- `reconcileRunningToIdle(missionId, generation)` is used when the process restarts or when `agent_end` belongs to a user-authored turn after an interrupted/running continuation; it clears stale `running` state before new classification.
- `markRunning(missionId, generation)` increments `autoTurnCount` exactly once when the row transitions `scheduled` to `running`; scheduling alone does not increment it.
- Conflicting writers must emit `mission.continuation.duplicate_suppressed` and must not call `sendMessage()`.
- At most one row may be `scheduled` or `running` for a mission id.

A continuation turn must carry this exact message envelope:

```ts
{
  customType: "mission-continuation",
  content: renderedPrompt,
  display: false,
  attribution: "agent",
  details: { missionId, generation }
}
```

`before_agent_start` marks the matching generation as `running`. `agent_end` advances it to `idle`, terminal, waiting, or schedules the next generation.

## Mission selection

A mission is continuable only when all conditions hold:

1. It is the active mission for the current session, or its continuation ledger row is owned by the current session/branch/tree.
2. It is not `completed`, `cancelled`, or `blocked` in Mission lifecycle.
3. Its continuation ledger status is not `paused`, `waiting_for_approval`, `budget_limited`, `blocked`, or `completed`.
4. It has a valid objective and lifecycle state.
5. It is not waiting on a proposal gate that requires user approval.
6. It is within budget.
7. It is not already scheduled or running for the same generation.

Selection order:

1. Current active mission id from `MissionControlRuntime` if non-terminal and eligible.
2. Persisted continuation record owned by the current session/branch/tree if its mission is non-terminal and eligible.
3. No mission.

The runtime intentionally does not select the most recently updated mission. If no active/owned mission exists, automatic continuation stops and Mission Control emits `mission.continuation.selected` with no mission id. The user can resume with `mission select <id>` or `mission resume <id>`.

## Branch and fork behavior

Mission continuation ownership is exclusive.

- On `session_branch` or `session_tree`, the runtime rehydrates and checks whether the ledger owner still matches the current branch/tree.
- On `session_switch` with reason `new`, treat the new session as ownership-mismatched: do not schedule against any prior ledger row. The prior mission remains owned by the old session id and is recoverable via `mission select` or `mission resume`.
- On `session_switch` with reason `resume`, scheduling is allowed only if the resumed session matches the ledger owner.
- On `session_switch` with reason `fork`, treat the fork as ownership-mismatched unless it explicitly clones/creates a new mission id or transfers ownership by user command.
- If ownership matches, continuation may proceed.
- If ownership does not match, the session may observe but must not schedule.
- A user command can transfer ownership by compare-and-swap from the old owner metadata to the current owner metadata.
- A fork that should perform independent work must clone or create a new mission id; it must not reuse the original mission continuation row.

## State machine

```text
Mission lifecycle:

created
  │
  ├─ proposal required ─► planning ── approved ─► executing
  │
  └─ no proposal gate ──────────────────────────► executing

executing
  ├─ existing completion path records outcome ──► completed
  ├─ real prerequisite missing ─────────────────► blocked
  ├─ user cancel ───────────────────────────────► cancelled
  └─ agent_end + still incomplete + idle ───────► executing

Continuation ledger status:

idle
  ├─ schedule CAS success ──────────────────────► scheduled
  ├─ user pause ────────────────────────────────► paused
  ├─ proposal gate ─────────────────────────────► waiting_for_approval
  ├─ budget exceeded ───────────────────────────► budget_limited
  └─ mission terminal observed ─────────────────► completed | blocked

scheduled ── before_agent_start generation match ─► running
running ──── agent_end same generation ───────────► idle | paused | waiting_for_approval | budget_limited | completed | blocked
paused ───── user resume ─────────────────────────► idle
```

`paused`, `waiting_for_approval`, and `budget_limited` are non-continuable ledger statuses until the user or policy changes them.

## Continuation decision algorithm

On `session_start` or resumptive `session_switch`:

1. Rehydrate the active/owned mission from persisted state.
2. Reconcile the continuation record with mission lifecycle.
3. If the mission is eligible, no user message is pending, and the host mode allows agent-initiated turns, run the same scheduling path as `agent_end`.
4. Re-check `ctx.hasPendingMessages()` immediately before `sendMessage()`.
5. If the check is still clear and CAS scheduling succeeds, send the hidden continuation next turn.

On `agent_end`:

1. Reconcile stale `running` ledger state first. If the ledger row is `running` with no matching incoming continuation envelope, or this `agent_end` belongs to a user-authored turn after a previously interrupted continuation, call `reconcileRunningToIdle()` before classification. If mission lifecycle is terminal, reconcile directly to the matching terminal continuation status.
2. Read current persisted mission view.
3. If no mission exists, clear in-memory continuation state and return.
4. If mission lifecycle is terminal, mark continuation terminal and return.
5. If `ctx.hasPendingMessages()`, mark `idle` with reason `user_message_pending` and return.
6. If continuation ledger status is `paused`, mark/keep `paused` and return.
7. If a proposal/approval gate blocks mutation, mark `waiting_for_approval` and return.
8. If budget is exceeded, mark `budget_limited` and return.
9. Run the shared acceptance preflight. Do not call `MissionRuntime.complete()` and do not fabricate a `MissionOutcome`.
10. If preflight passes but no real completion outcome is recorded, schedule a continuation turn whose only required next step is to record Mission Control completion with a real outcome.
11. If preflight fails because required verification or phases are missing, schedule a continuation turn focused on the next missing requirement.
12. If preflight or mission evidence shows a real external prerequisite is unavailable, mark blocked.
13. Immediately before scheduling, re-check `ctx.hasPendingMessages()`.
14. Schedule the next generation only through ledger CAS. If CAS fails, emit duplicate suppression and return.
15. Send the hidden continuation message with the required envelope.

Important distinction: verification failure is work to continue; unavailable prerequisite is a block.

## Completion semantics

The continuation runtime must not implement a second completion policy. Extract the acceptance checks behind `MissionRuntime.complete()` into a shared preflight used by both manual completion and continuation classification.

Completion preflight requires:

- Required decision record if the mission template requires it.
- Required regression contract if the mission template requires it.
- Required verification pass if the mission template requires it.
- All phases verified.
- No recorded failing verification unless the mission is explicitly forced.

If these gates are not met, the mission continues. It is not marked complete, and the continuation prompt must name the missing gates.

If all gates pass but no outcome exists, the continuation prompt must instruct the agent to record the outcome through the existing Mission Control completion path. The runtime must not invent the outcome from event metadata.

## Prompt contract

Hidden continuation messages must follow this shape:

```md
Mission Control continuation

Mission: <id>
Objective: <objective>
Lifecycle: <lifecycle>
Continuation status: <status>
Continuation generation: <n>

Incomplete gates:
- <gate>

Last observed status:
- <summary>

Required next behavior:
- Continue the next smallest safe step toward satisfying the missing gates.
- Prefer direct implementation and verification over planning.
- Do not stop because this turn is complete; stop only when the mission is complete, blocked, cancelled, continuation-paused, waiting for approval, or budget-limited.
- If blocked by unavailable external information, record the block in Mission Control.
- If acceptance passes, record Mission Control completion with a real outcome summary through the existing completion path.
```

The message must be hidden from the transcript UI by default but persisted as a custom message for replay and debugging.

`before_agent_start` must inject mission context for every non-terminal active mission, not only for hidden continuation turns. Injection must append a dedicated system prompt entry through `BeforeAgentStartEventResult.systemPrompt`; it must never mutate the user prompt text. This protects long missions across compaction and user-authored turns while preserving user-turn provenance. User-authored turns should also get a visible breadcrumb or status-bar indicator that an active mission context is attached.

## User controls

Mission Control commands should include:

- `mission pause [id]`: sets continuation ledger status to `paused` without changing mission lifecycle.
- `mission resume [id]`: sets continuation ledger status to `idle`, acquires ownership for the current session/branch/tree, and schedules a continuation if idle.
- `mission stop [id]`: cancels continuation and optionally cancels the mission.
- `mission status [id]`: shows lifecycle, continuation status, generation, last reason, last scheduled time, and budgets.
- `mission select <id>`: resolves ownership/selection by CAS ownership transfer.

Continuation must also pause automatically when a user message is pending. After the user-authored turn completes, continuation may resume implicitly if the mission remains active and the user did not pause, cancel, block, complete, or select another mission.

## Budgets and runaway protection

Required controls:

- Per-mission maximum automatic turns.
- Optional wall-clock deadline.
- Optional token budget estimate.
- Duplicate generation suppression.
- Minimum scheduling interval to avoid immediate tight loops after no-op turns.
- Consecutive no-progress limit.
- Consecutive tool/error failure limit.

A budget stop is not mission completion. It records `budget_limited` and waits for user action.

No-progress detection must use observable state, not model self-report alone. The progress fingerprint should be derived from implementable fields and queries:

- Mission contract count and latest contract id/content hash.
- Verification record count, latest verdict, and latest summary digest.
- Phase status vector from `mission.phases`.
- Task attempt checkpoint count and latest checkpoint id/content hash.
- Evidence-card, critic-dialogue, rollback, and world-model record counts plus latest ids.
- Scope/touched-file evidence if recorded by `MissionScopeGuard` or task checkpoints.

The fingerprint must explicitly exclude fields written by the continuation runtime itself, including `mission.updatedAt`, ledger `generation`, ledger `updatedAt`, scheduling timestamps, and `lastReason`. Those fields remain useful for display and debugging but must not participate in no-progress equality checks.

A no-progress tick is a completed continuation generation whose fingerprint is identical to the previous generation and that produced no new file/evidence/verification/task signal. Default stop policy: after three consecutive no-progress generations, set ledger status `paused` with reason `no_progress_limit` and surface the pause in Mission Control.

Per-mission maximum automatic turns, wall-clock deadline, and token estimate live on the existing mission budget structure, extended if necessary. The continuation ledger stores only observed usage and scheduling counters.

## Session, compaction, and process restart behavior

On `session_start` and resumptive `session_switch`:

1. Rehydrate active/owned mission from persisted state.
2. Reconcile continuation record with mission lifecycle.
3. If a previous generation was `running`, classify it as interrupted and either resume or pause depending on budget/no-progress policy.
4. If eligible and host mode allows agent-initiated turns, arm cold-start continuation but defer scheduling until the host reports the UI/session is idle after startup. The user must see an active-mission breadcrumb before the hidden turn can be scheduled, so a fresh TUI start cannot preempt the user's first input opportunity.
5. When an owned non-terminal ledger row is found, restore `MissionControlRuntime`'s in-memory active mission pointer from the ledger row before command handlers or prompt injection read active mission state.

On `before_agent_start`:

1. Rehydrate active mission from persisted state.
2. Reconcile continuation record with mission lifecycle.
3. If the incoming message is a continuation message with `{ missionId, generation }`, mark that generation as running.
4. Inject mission context into the system/user context for that turn.
5. If the incoming message is user-authored, do not silently override it; attach mission context only if the selected mission remains active and surface a visible active-mission breadcrumb.

On compaction:

- Do not rely on prior hidden continuation text remaining in context.
- `before_agent_start` must rebuild mission context from `MissionReadModel` every turn.
- If compaction creates a new session branch/tree, ownership rules apply before scheduling.

On `session_shutdown`:

- Clear memory caches and UI widgets.
- Do not clear persisted active mission or continuation record.
- If a generation was `running`, leave it recoverable. On next startup, classify it as interrupted and either resume or wait depending on budget/no-progress policy.

## Host mode behavior

- Interactive/TUI: continuation is enabled by default.
- ACP: continuation is enabled only when the ACP host allows agent-initiated turns. Otherwise, eligible continuations remain `idle` with reason `host_disallows_agent_initiated_turns`.
- RPC: continuation is enabled only when the RPC transport exposes the same safe agent-initiated turn capability.
- Print/non-interactive one-shot mode: continuation is disabled. The mission may be created/updated, but no hidden next turn is scheduled.

## UI and observability

Mission Control should show:

- Active mission id and title.
- Lifecycle state.
- Continuation status.
- Current generation.
- Auto turn count.
- Owner session/branch/tree.
- Last scheduled/started/ended timestamps.
- Last stop/schedule reason.
- Missing acceptance gates.
- Last verification verdict.
- Host-mode eligibility.

Events to emit:

- `mission.continuation.selected`
- `mission.continuation.scheduled`
- `mission.continuation.started`
- `mission.continuation.completed`
- `mission.continuation.paused`
- `mission.continuation.blocked`
- `mission.continuation.budget_limited`
- `mission.continuation.waiting_for_approval`
- `mission.continuation.duplicate_suppressed`
- `mission.continuation.ownership_transferred`
- `mission.continuation.host_disallowed`

These events should be available through the mission event stream and MissionReadModel projection. `MissionReadModel` must expose a continuation projection field derived from the ledger and event replay: `status`, `generation`, `owner`, `autoTurnCount`, `lastReason`, `lastScheduledAt`, and host eligibility. Replay tests rebuild this projection from the same emitted events.

## Integration with existing code

Recommended implementation points:

1. Add a built-in extension under `packages/coding-agent/src/mission/continuation/`.
2. Register it from the same extension/bootstrap path that currently enables built-in runtime extensions.
3. Reuse the `autoresearch/index.ts` continuation pattern for `agent_end` scheduling and cold-start scheduling.
4. Reuse `MissionControlRuntime` for active mission mutation and user commands.
5. Reuse `MissionReadModel` for prompt context and UI projection.
6. Extract shared acceptance preflight from `MissionRuntime.complete()`; do not duplicate its rules.
7. Add persistence through `MissionStore`, not in-memory runtime state.

Avoid:

- A second mission lifecycle state machine separate from `MissionRuntime`.
- Prompt-only loops with no persisted scheduling record.
- Completion based on model self-report.
- Auto-continuation while user input is queued.
- Clearing active mission on session shutdown.
- Scheduling more than one next turn per mission generation.
- Selecting a mission by most-recent update when no active/owned mission exists.

## Implementation phases

### Phase 1: Continuation ledger and pure policy

Deliverables:

- Continuation record schema/store methods with primary key `missionId`.
- CAS methods for schedule, running, idle, stale-running reconciliation, ownership transfer, pause, resume, and terminal observation.
- `classifyContinuation()` pure function.
- Shared acceptance preflight extracted from `MissionRuntime.complete()`.
- Parity tests verifying that the extracted preflight returns the same accept/reject decisions as the prior in-method checks for every existing `MissionRuntime.complete()` rejection case.
- Tests for terminal, paused, pending-user-message, no active/owned mission, budget-limited, duplicate generation, ownership mismatch, stale-running reconciliation, and incomplete verification cases.

### Phase 2: Extension hooks

Deliverables:

- Built-in mission continuation extension.
- `session_start` and resumptive `session_switch` cold-start scheduling.
- `before_agent_start` rehydration and context injection.
- `agent_end` continuation evaluation.
- Hidden `nextTurn` scheduling with the required message envelope.
- Session shutdown cleanup that does not erase persisted mission state.

### Phase 3: Prompt and context injection

Deliverables:

- `prompt.md` template.
- Prompt builder using `MissionReadModel`.
- Tests that missing gates appear in the prompt and terminal missions produce no prompt.
- Tests that user-authored turns still receive active mission context after compaction.

### Phase 4: Completion integration

Deliverables:

- Shared completion preflight with parity tests against `MissionRuntime.complete()` acceptance failures.
- Continuation classification that maps missing acceptance gates to continued work.
- Prompt behavior that asks the agent to record a real outcome when gates pass but no completion outcome exists.

### Phase 5: User controls and UI

Deliverables:

- Pause/resume/select/status commands.
- Ownership transfer semantics.
- Mission Control projection fields for continuation status.
- Event stream coverage.
- Visible active-mission breadcrumb on user-authored turns.

### Phase 6: Hardening

Deliverables:

- Duplicate-turn suppression.
- Interrupted generation recovery.
- No-progress detection.
- Budget enforcement.
- Host mode gating.
- Regression tests for multi-turn continuation, restart/resume, branch/fork ownership, ACP gating, and compaction re-injection.

## Test plan

Unit tests:

- `classifyContinuation()` returns stop for terminal states.
- `classifyContinuation()` returns pause for pending user messages.
- `classifyContinuation()` returns continue for executing incomplete mission.
- `classifyContinuation()` returns no selection when no active/owned mission exists.
- Duplicate scheduled generation is suppressed by CAS.
- Budget-limited mission does not schedule.
- Ownership mismatch does not schedule.
- Completion preflight matches `MissionRuntime.complete()` acceptance requirements.
- No-progress fingerprint increments pause after the configured threshold.

Integration tests:

- Active mission schedules exactly one hidden `nextTurn` after `agent_end`.
- Pending user message prevents scheduling, including a final re-check immediately before `sendMessage()`.
- Cold restart rehydrates active mission, restores the in-memory active mission pointer, surfaces an active-mission breadcrumb, waits for startup idle, and then schedules eligible continuation without a new user prompt in interactive mode.
- Running generation interrupted by shutdown is recoverable.
- Mission with missing verification continues until verification passes.
- Mission with passing verification but no outcome prompts the agent to record completion instead of fabricating an outcome.
- Mission completed through the existing completion path clears continuation state.
- Continuation-paused mission remains persisted but never schedules.
- Blocked mission remains terminal/non-continuable.
- Branch/fork/new-session ownership mismatch prevents double scheduling.
- ACP host disallowing agent-initiated turns leaves mission idle with a visible reason.
- Compaction does not lose mission context because `before_agent_start` rebuilds it.

Replay tests:

- Continuation events reconstruct the same MissionReadModel projection.
- Ledger generation prevents duplicate next-turn scheduling after repeated `agent_end` delivery.
- Ownership transfer is replayable and produces one scheduler owner.

## Review checklist

Before implementation is accepted:

- There is only one completion acceptance policy.
- There is only one persisted mission lifecycle source.
- Continuation statuses are not confused with mission lifecycle states.
- Auto-continuation never overrides pending user input and re-checks before sending.
- Every scheduled continuation has a mission id and generation in the required envelope.
- Ledger scheduling is CAS-based and keyed by mission id.
- Terminal states cannot resume accidentally.
- Session shutdown does not erase active mission state.
- Cold-start restart behavior is covered by tests.
- Branch/fork behavior cannot double-process a mission.
- Host mode gating is explicit.
- The prompt names concrete missing gates.
- The UI exposes why continuation stopped.
- Budget/no-progress limits stop scheduling without pretending success.
