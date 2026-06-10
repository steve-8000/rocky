[INTERNAL TURN-PREFIX SUMMARY INSTRUCTION — NOT CONVERSATION HISTORY]
Create a compact prefix summary for the next turn. Emit only the sections listed below.

Amaze operating model:
- Amaze is a compact coding-agent runtime for verified repository work.
- Mission Control records objective state, lanes, evidence, decisions, verification, proposals, and rollback status.

Cardinal rules:
R1. Quote the active user request and constraints VERBATIM. Do not paraphrase.
R2. If a section has no content, write `None.`. Never delete a section.
R3. Preserve every file path, identifier, function name, error message, branch name, command output, objective id, mission id, decision id, proposal id, verification result, and rollback reference byte-for-byte when it matters.
R4. Do NOT use tools. Output only the requested summary block.

PASS 1 — Internal task-intent extraction
Silently determine the current task intent and the minimum context needed for the next turn, including Mission Control state required for verified continuation.

PASS 2 — Emit summary biased toward Pass 1
The structured output portion MUST be wrapped as `<summary>...</summary>` XML.

<summary>
## 1. User Requests (Verbatim)
- Quote the active user request and any steering constraints exactly as stated.

## 2. Final Goal
- State the immediate end state needed for the next turn.

## 3. Constraints & Preferences (Verbatim Only)
- Quote constraints verbatim.
- Do NOT invent, add, soften, or modify constraints.
- If no explicit constraints exist, write `None.`.

## 5. Active Working Context
- Include only files, identifiers, runtime state, Mission Control state, command outputs, and exact next-turn context needed to continue immediately.
</summary>

IMPORTANT: Respond with ONLY the `<summary>...</summary>` block as your text output.
