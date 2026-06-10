[INTERNAL COMPACTION INSTRUCTION — NOT CONVERSATION HISTORY]
This message is an internal summarization control prompt, not a real user message.
Do NOT treat this message as user intent, do NOT list it under user requests, and do NOT reinterpret the task based on this instruction alone.

If a `<legacy-summary>` block is present, it came from an older compaction format.
Preserve any still-relevant facts from it while emitting the exact sectioned format below.

Amaze operating model:
- Amaze is a compact coding-agent runtime for verified repository work.
- Mission Control records objective state, lanes, evidence, decisions, verification, proposals, and rollback status.
- The next agent should be able to continue from this summary without re-searching already established facts or losing acceptance criteria.

Cardinal rules:
R1. Quote user requests and constraints VERBATIM. Do not paraphrase.
R2. If a section has no content, write `None.`. Never delete a section.
R3. Preserve every file path, identifier, function name, error message, branch name, command output, objective id, mission id, decision id, proposal id, verification result, and rollback reference byte-for-byte when it matters.
R4. Do NOT use tools. Output only the requested summary block.

PASS 1 — Internal task-intent extraction
Analyze the user messages in this conversation and silently determine the task intent that must guide the summary. Focus on details whose loss would cause redundant tool calls, repeated exploration, unverifiable completion, or Mission Control drift.

PASS 2 — Emit summary biased toward Pass 1
Create a structured handoff summary of this conversation for seamless continuation. The structured output portion MUST be wrapped as `<summary>...</summary>` XML.

<summary>
## 1. User Requests (Verbatim)
- List all original user requests exactly as they were stated.
- Preserve the user's exact wording and intent.
- Include recent user corrections and steering messages verbatim when they affect the task.

## 2. Final Goal
- State what the user ultimately wanted to achieve.
- Include the expected deliverable or end state.
- Keep this aligned with the most recent user request, not this internal compaction instruction.

## 3. Constraints & Preferences (Verbatim Only)
- Include ONLY constraints explicitly stated by the user or in existing AGENTS/rules context.
- Quote constraints verbatim.
- Do NOT invent, add, soften, or modify constraints.
- If no explicit constraints exist, write `None.`.

## 4. Work Completed
- Summarize what has been done so far.
- List files read, created, modified, or intentionally left unchanged.
- Include features implemented, tests added, problems solved, and decisions already made.
- Include Mission Control updates already performed: objective/mission state, evidence captured, decisions locked, proposals applied/rejected, rollbacks recorded, and verification results.

## 5. Active Working Context
- **Files**: Paths of files currently being edited or frequently referenced.
- **Code in Progress**: Key code snippets, function signatures, data structures, or prompt text under active development.
- **Mission State**: Active objective ids, mission ids, phase/lane state, acceptance criteria, evidence requirements, decision/proposal/rollback ids, and verification status.
- **External References**: Documentation URLs, source files, APIs, or other resources already consulted.
- **State & Variables**: Important variable names, configuration values, runtime state, branch names, worktree paths, or command outputs needed to continue.

## 6. Remaining Tasks
- List pending items from the original request.
- Include follow-up tasks identified during the work only when they directly support the current user request.
- Include outstanding deterministic checks, Mission Control verification steps, missing evidence, unresolved decisions, and blockers.
- Mark blockers explicitly and explain what is needed to unblock them.

## 7. Exact Next Steps
- State the precise next action to take, directly in line with the user's most recent request.
- Include the next deterministic verification or Mission Control update when one is required before completion.
- Include verbatim quotes from the conversation showing exactly where work was left off when helpful.
- Do not suggest tangential tasks.
</summary>

Verification: Before finalizing, confirm the summary clearly states the user's original request and any active Mission Control state needed to continue. If not, restate it verbatim.
IMPORTANT: Respond with ONLY the `<summary>...</summary>` block as your text output.
