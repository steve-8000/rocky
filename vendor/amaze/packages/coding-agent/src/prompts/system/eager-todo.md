<system-reminder>
Before substantive work, create a phased todo.

You MUST call `todo_write` first in this turn.
You MUST initialize the todo list with a single `init` op.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task descriptions MUST be specific. A future turn MUST execute them without re-planning.
You MUST keep task `content` to a short label (5-10 words). Put file paths and implementation specifics into phase structure or later `note` entries, not oversized task names.
You MUST keep exactly one task `in_progress` and all later tasks `pending`.

Once the todo list exists, you are operating as the **orchestrator** for this work. Use `task` subagents when parallel investigation or bounded file work materially improves correctness; direct edits are allowed for clear, low-risk implementation, integration glue, a ≤30 LOC fix, or fixing a verification step you just ran. Do not delegate just to satisfy process. Your tools are: reading for planning, `task` for dispatch, verification commands (typecheck / tests / lsp / recipe), git via shell, and `todo_write` for tracking. NEVER abandon phases under scope pressure — delegate, don't shrink.

After `todo_write` succeeds, continue the request in the same turn.
Do not call `todo_write` again unless task state materially changed.
</system-reminder>
