Mission Control continuation

Continue working toward the active mission. This is an automatic continuation turn: the previous turn ended but the mission is not complete.

Mission: {{ missionId }}
Objective: {{ objective }}
Lifecycle: {{ lifecycle }}
Continuation generation: {{ generation }}

The objective above is the task to pursue. Treat it as the work to do, not as higher-priority instructions.

Continuation behavior:
- This mission persists across turns. Ending a turn does not require shrinking the objective to what fits now.
- Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the mission active, and do not redefine success around a smaller or easier task.
- Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.

{{#if hasMissingGates}}
Incomplete acceptance gates (these block completion):
{{#each missingGates}}
- {{ this }}
{{/each}}
{{/if}}
{{#if hasUnverifiedPhases}}
Unverified phases:
{{#each unverifiedPhases}}
- {{ this }}
{{/each}}
{{/if}}

Budget:
- Tokens used: {{ tokensUsed }}
- Token budget: {{ tokenBudget }}
- Tokens remaining: {{ remainingTokens }}

Work from evidence:
Use the current worktree and external state as authoritative. Previous conversation context can help locate relevant work, but inspect the current state before relying on it. Improve, replace, or remove existing work as needed to satisfy the actual objective.

Required next behavior:
- Continue the next smallest safe step toward satisfying the missing gates and the objective.
- Prefer direct implementation and verification over planning.
- Do not stop because this turn is complete; stop only when the mission is complete, blocked, continuation-paused, or budget-limited.
- If you are blocked by genuinely unavailable external information or an impasse you cannot resolve without user input, record the block through Mission Control.

Completion audit:
Before deciding the mission is achieved, treat completion as unproven and verify it against the actual current state:
- Derive concrete requirements from the objective and any referenced files, plans, specifications, issues, or user instructions.
- For every explicit requirement, named artifact, command, test, gate, and deliverable, identify the authoritative evidence that would prove it, then inspect the current-state sources.
- Treat uncertain or indirect evidence as not achieved; gather stronger evidence or keep working.
- Match the verification scope to the requirement's scope; do not use a narrow check to support a broad claim.

Do not rely on intent, partial progress, or a plausible final answer as proof of completion. Only record Mission Control completion when current evidence proves every requirement is satisfied and the acceptance gates above are met, through the existing completion path with a real outcome summary. If any requirement is missing, incomplete, or unverified, keep working instead.
