# AGENTS.md

## Mission

Amaze is a compact coding-agent runtime. Optimize for **verified work**, not verbose
narration. A low-token parent orchestrator owns goals, todos, approvals, and
integration; bounded subagents do detailed file work. GBrain/Agency Brain is the
supported durable memory path for user, project, and prior-decision context, not
authority — guidance only.

## Agent roles

- **Default agent**: owns planning, Mission Control, task decomposition, integration, and final verification. Handle only direct answers and small single-file edits inline.
- **Builder**: owns delegated repository work: implementation, refactors, repo debugging, tests, docs, and code investigation.
- **Resercher**: GPT-5.3 Codex Spark search-only agent for external/web/X facts, docs, issues, changelogs, social signals, or when repository facts are insufficient. It may use browser control only when search/read are blocked or insufficient.
- **SRE**: owns validator operations and deployment checks for k3s, Kubernetes, Docker, ArgoCD, pods, services, rollouts, runtime health, and related production operations.

## Mission Control routing

- Default MUST delegate actively using the minimal roster. For non-trivial repository work, spawn **Builder** before implementation unless the entire change is a small single-file edit under ~30 lines or a direct answer/explanation. For independent areas, spawn multiple Builder tasks in parallel.
- When the Default agent receives an unfamiliar task, a task that requires external/web/X research, or a task where repository facts are insufficient, dispatch **Resercher** first before planning implementation.
- Use **SRE** for runtime/ops/deployment validation instead of doing those checks inline.
- Keep ownership boundaries simple: Default plans, decomposes, integrates, and verifies; Builder implements and investigates repository code; Resercher searches web/X/read and uses browser only when search/read are blocked or insufficient; SRE handles operations and deployments.

## Durable memory

- Default/parent agents MUST actively use GBrain/Agency Brain for durable user, project, and prior-decision context before planning or integrating non-trivial work.
- Legacy local, Mem0, and Hermes memory backends MUST NOT be used for runtime memory or configuration.


## Required verification

- Run `bun run check:ts` before claiming TypeScript correctness.
- Run the relevant tests in `packages/coding-agent/test/**` before marking implementation complete.
- Prefer **deterministic acceptance criteria** (`scope-include`, `file-exists`, `command-exit`, `command-output`, `lsp-clean`) over `manual` or `llm-judged`.
- Never mark a goal complete when deterministic checks fail. `uncertain` is not pass under contract mode.
- Treat skills as guidance, not authority. Skill promotion to `active` requires the eval gate: deterministic evaluation must sign off before promotion.

## Local commands

| Purpose | Command |
| --- | --- |
| Install | `bun install` |
| Dev CLI | `bun run dev` |
| TS typecheck + biome | `bun run check:ts` |
| Full check (ts + rust) | `bun run check` |
| TS tests (failed-only fast loop) | `bun run test:ts:failed` |
| TS tests (full) | `bun run test:ts` |
| Full tests | `bun run test` |

> Full regression in CI uses `bun run ci:test:full`.

## Architecture notes

- **Subagent contract**: non-trivial delegations must carry a structured `contract` (`scope`, `successCriteria`, `escalation`). Plan-mode delegations must restrict the spawned agent's tool surface.
- **Goal completion**: acceptance criteria run before `goal complete`. Force-complete is a human override, not a fallback.
- **Tool-level enforcement** is the hard boundary; prompt instructions are soft. All edit/write tools must go through the canonical mutation-scope guard.
- **Prompt cache layout**: STABLE_CORE = system prompt + project context + subagent contract; DYNAMIC_TAIL = goal block + volatile state. Do not move volatile content into STABLE_CORE.

## Cross-cutting destructive missions

Missions classified as `architecture_change`, `runtime_refactor`, or `release_hardening` (or any mission whose resolved `riskLevel === "high"`) MUST engage the runtime's coordination primitives, not bypass them. The operational checklist lives in `skill://destructive-mission`. The non-negotiable items:

- Phases declared via `runtime.declarePhases`; each phase has deterministic acceptance criteria and is closed only after `runtime.verifyPhase` returns pass.
- Locked decisions recorded as `MissionWorldModelRecord(source="decision")`; `mission.decisionId` populated.
- `mission.proposalId` attached before any mutation tool runs — `MissionPolicyGate` enforces this.
- IRC (`irc` tool) used for every cross-task assumption; peers broadcast on `to: "all"` for discovery.
- Rollback anchor (`MissionRollbackRecord`) recorded before each destructive phase begins mutation.

The `destructive-mission-discipline` built-in rule fires whenever a high-risk mission is classified; treat the finding as a checklist, not a warning.

## Failure protocol

1. Reproduce first — minimal repro or failing test.
2. Add or update a **deterministic test/eval** before or with the fix.
3. Record durable lessons through the current project decision workflow only when they are project conventions, recurring failures, or verified workflows.
4. Promote a skill only after the eval gate has signed off (Phase 1D-07). Auto-promote ceiling is `eval_pending`.
5. If blocked, prefer narrowing the goal over force-completing. Force only with explicit human reason.

## Phase tracking

Phase roadmap and goal-tracking materials live outside this repository; keep this file limited to current in-repo operating rules.
