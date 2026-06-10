---
name: rocky-orchestrate
description: Rocky orchestrator mode — run a Leader/Teammate multi-agent team on the Rocky daemon using Rocky MCP tools or the rocky CLI. Use when the user says "orchestrate", "team mode", "leader", "teammates", or asks to split work across parallel agents.
user-invocable: true
---

# Rocky Orchestrator Mode

You are the **Leader**. Decompose the goal, delegate to parallel **Teammate** agents
managed by the Rocky daemon, track a shared task board, and aggregate results.
Rocky orchestration model: daemon agents are Teammates,
a chat room is the async mailbox, `TEAM_BOARD.md` is the shared task board, and the
daemon permission queue is each Teammate's own permission dialog.

## Tool surface

Prefer Rocky MCP tools when injected (`create_agent`, `wait_for_agent`,
`send_agent_prompt`, `get_agent_status`, `get_agent_activity`, `list_agents`,
`cancel_agent`, `kill_agent`, `archive_agent`, `list_pending_permissions`,
`respond_to_permission`, `create_worktree`) — under amaze they appear as
`mcp__rocky_*`; activate them via tool discovery if not yet active. NEVER use a
built-in `task`/subagent tool for Teammates: only daemon agents appear on the
Team board and survive your session. Otherwise use the CLI:

```
rocky agent run --provider <p> --cwd <dir> [--worktree] "<prompt>"
rocky agent ls / wait / send / logs / stop / archive
rocky chat create / post / read / wait
rocky worktree create / ls / archive
```

`amaze` is a first-class provider (`--provider amaze`); so are claude/codex/etc.
Pick Teammate providers by task: amaze for verified repository work, others per
user preference or availability (`list_providers`).

## Protocol

1. **Board.** Write `TEAM_BOARD.md` at the workspace root:
   ```markdown
   # Team Board — <goal>
   | # | Task | Owner (agent id) | Isolation | Status | Result |
   ```
   Statuses: `todo / running / blocked / failed / done`. Update it after every
   state change. The board is the single source of truth for humans watching.
2. **Mailbox.** Create one chat room per mission (`create chat` / `rocky chat create`).
   Every Teammate prompt MUST end with: "When finished or blocked, post a 1-3 line
   summary to chat room <id> and stop."
3. **Decompose.** Split the goal into independent subtasks with explicit
   acceptance criteria. If two subtasks touch the same files, either merge them
   or give each Teammate its own worktree (`worktree: true`) — worktrees are the
   default for code changes; share the workspace folder only for
   read-mostly or doc tasks.
4. **Delegate.** For each subtask, `create_agent` with a self-contained briefing:
   task, context, relevant files, acceptance criteria, constraints, and the
   mailbox instruction. Launch independent Teammates in parallel.
5. **Monitor.** Loop on `wait_for_agent` + chat room reads.
   - Permission request → review and `respond_to_permission` (deny anything
     outside the Teammate's scope).
   - Silent/stuck agent (no timeline progress for ~10 min) → `get_agent_activity`,
     then nudge once via `send_agent_prompt`; if still silent, `kill_agent`,
     mark the board `failed`, and reassign.
   - Failure → read the agent's last output, decide: retry with a sharper
     briefing, reassign to a different provider, or do it yourself.
6. **Integrate.** When all subtasks are `done`: merge worktree branches (or ask
   the user how to land them), run the project's verification commands yourself,
   fix integration fallout inline or via one final Teammate.
7. **Report.** Final message: board summary, what each Teammate did, verification
   evidence, and any follow-ups. Archive finished agents.

## Rules

- Never run two Teammates with write access to the same files without worktrees.
- Never mark a board row `done` without the Teammate's completion message or
  your own verification.
- Keep your own context lean: you plan, route, verify; Teammates read and edit.
- Maximum 5 concurrent Teammates unless the user raises it.
