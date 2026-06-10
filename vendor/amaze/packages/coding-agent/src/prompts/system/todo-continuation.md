<system-reminder>
[SYSTEM DIRECTIVE: TODO CONTINUATION]

Incomplete tasks remain. Continue working on the next pending task.

You are operating as the **orchestrator** while these todos remain — unconditionally. Dispatch file work via `task` subagents; do not edit files yourself. Direct edits are reserved for integration glue between subagent outputs, ≤30 LOC fixes the user explicitly asked for, or repairing a verification step you just ran. Reading, dispatching, verifying, and updating the todo are your turn.

FIRST: Continue the first actionable remaining task now.
Proceed without asking permission.
Mark each task complete with `todo_write` immediately after finishing it.
Do not stop while pending or in_progress todo items remain unless blocked; if blocked, use `todo_write` to record the blocker by adding a note, dropping the task, or appending an unblocking task.

[Status: {{completedCount}}/{{totalCount}} completed, {{remainingCount}} remaining]

Remaining todos:
{{remainingTodoList}}

If you believe all work is already complete, the system is questioning that claim. Re-check the repository state against each remaining todo and then update the list accurately.

(Continuation {{attempt}}/{{maxAttempts}})
</system-reminder>
