<previous-summary>
{{previousSummary}}
</previous-summary>

[INTERNAL COMPACTION UPDATE INSTRUCTION — NOT CONVERSATION HISTORY]
The messages above are NEW conversation messages to incorporate into the existing summary provided in `<previous-summary>` tags.

Amaze operating model:
- Amaze is a compact coding-agent runtime for verified repository work.
- Mission Control records objective state, lanes, evidence, decisions, verification, proposals, and rollback status.
- The next agent should be able to continue from this summary without re-searching already established facts or losing acceptance criteria.

Cardinal rules:
R1. Quote user requests and constraints VERBATIM. Do not paraphrase.
R2. If a section has no content, write `None.`. Never delete a section.
R3. Where a previous summary is supplied, treat its User Requests, Final Goal, and Constraints fields as IMMUTABLE. Append, never rewrite, those three sections.
R4. Preserve every file path, identifier, function name, error message, branch name, command output, objective id, mission id, decision id, proposal id, verification result, and rollback reference byte-for-byte when it matters.
R5. Do NOT use tools. Output only the requested summary block.

PASS 1 — Internal task-intent extraction
Analyze the new user messages and silently determine which updates are needed without changing immutable prior User Requests, Final Goal, or Constraints. Preserve Mission Control state whose loss would cause unverifiable completion or repeated coordination work.

PASS 2 — Emit summary biased toward Pass 1
Update the structured handoff summary. The structured output portion MUST be wrapped as `<summary>...</summary>` XML.

<summary>
## 1. User Requests (Verbatim)
- Preserve prior entries from `<previous-summary>` byte-for-byte.
- Append new user requests exactly as they were stated.

## 2. Final Goal
- Preserve the existing final goal unless the user explicitly changed it.
- Append the explicit change verbatim if the goal changed.

## 3. Constraints & Preferences (Verbatim Only)
- Preserve prior constraints byte-for-byte.
- Quote constraints verbatim.
- Do NOT invent, add, soften, or modify constraints.
- Append only new explicit constraints.
- If no explicit constraints exist, write `None.`.

## 4. Work Completed
- Preserve completed work from the previous summary.
- Add newly completed work, files changed, tests run, and decisions made.
- Add Mission Control updates already performed: objective/mission state changes, evidence captured, decisions locked, proposals applied/rejected, rollbacks recorded, and verification results.

## 5. Active Working Context
- Update files, code in progress, external references, state, variables, branch names, worktree paths, and command outputs needed to continue.
- Preserve active objective ids, mission ids, phase/lane state, acceptance criteria, evidence requirements, decision/proposal/rollback ids, and verification status.

## 6. Remaining Tasks
- Remove tasks only when the new messages prove they are completed or cancelled.
- Add newly identified direct follow-up tasks.
- Include outstanding deterministic checks, Mission Control verification steps, missing evidence, unresolved decisions, and blockers.

## 7. Exact Next Steps
- Update based on current state and the user's most recent request.
- Keep this direct and immediately actionable.
- Include the next deterministic verification or Mission Control update when one is required before completion.
</summary>

IMPORTANT: Respond with ONLY the `<summary>...</summary>` block as your text output.
