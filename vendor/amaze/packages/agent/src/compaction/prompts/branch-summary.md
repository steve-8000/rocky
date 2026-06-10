[INTERNAL BRANCH SUMMARY INSTRUCTION — NOT CONVERSATION HISTORY]
Create a structured summary of this conversation branch for context when returning later. This is a branch-level handoff, so reorient §2 toward the branched intent and why this branch exists.

Amaze operating model:
- Amaze is a compact coding-agent runtime for verified repository work.
- Mission Control records objective state, lanes, evidence, decisions, verification, proposals, and rollback status.

Cardinal rules:
R1. Quote user requests and constraints VERBATIM. Do not paraphrase.
R2. If a section has no content, write `None.`. Never delete a section.
R3. Preserve every file path, identifier, function name, error message, branch name, command output, objective id, mission id, decision id, proposal id, verification result, and rollback reference byte-for-byte when it matters.
R4. Do NOT use tools. Output only the requested summary block.

PASS 1 — Internal task-intent extraction
Analyze this branch and silently determine the branch-specific intent, divergence point, Mission Control state, and details whose loss would cause repeated work or unverifiable completion.

PASS 2 — Emit summary biased toward Pass 1
Create a structured branch handoff summary. The structured output portion MUST be wrapped as `<summary>...</summary>` XML.

<summary>
## 1. User Requests (Verbatim)
- List user requests that caused or shaped this branch exactly as they were stated.
- Preserve the user's exact wording and intent.

## 2. Final Goal
- State the branched intent: what this branch was trying to accomplish, test, compare, or preserve.
- Include how this branch differs from the mainline path when known.

## 3. Constraints & Preferences (Verbatim Only)
- Include ONLY constraints explicitly stated by the user or in existing AGENTS/rules context.
- Quote constraints verbatim.
- Do NOT invent, add, soften, or modify constraints.
- If no explicit constraints exist, write `None.`.

## 4. Work Completed
- Summarize branch-specific progress.
- List files read, created, modified, or intentionally left unchanged on this branch.
- Include branch-specific Mission Control updates: objective/mission state, evidence, decisions, proposals, rollbacks, and verification results.

## 5. Active Working Context
- **Files**: Paths of files currently edited or frequently referenced in this branch.
- **Code in Progress**: Key snippets, signatures, data structures, or prompt text under active development.
- **Mission State**: Active objective ids, mission ids, phase/lane state, acceptance criteria, evidence requirements, decision/proposal/rollback ids, and verification status for this branch.
- **External References**: Sources already consulted for this branch.
- **State & Variables**: Branch names, worktree paths, runtime state, command outputs, and identifiers needed to resume.

## 6. Remaining Tasks
- List branch-specific work still needed.
- Include blockers and the concrete condition needed to unblock them.
- Include outstanding deterministic checks or Mission Control verification steps.

## 7. Exact Next Steps
- State the precise next action for returning to this branch.
- Include the next deterministic verification or Mission Control update when one is required before completion.
- Do not suggest tangential tasks.
</summary>

IMPORTANT: Respond with ONLY the `<summary>...</summary>` block as your text output.
