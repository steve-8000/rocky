Reads the current phased todo list for this session without changing it.

Use this when you need to inspect current task progress before deciding what to update with `todo_write`, especially after a continuation, branch/resume, or user-side `/todo` edit.

The result returns phases with tasks and statuses:
- `pending` — not started
- `in_progress` — current active task
- `completed` — done
- `abandoned` — intentionally dropped

Do not use `todo_read` to stall. If the current todo state is already visible in recent context, continue work directly or update it with `todo_write`.
