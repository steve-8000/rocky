---
name: destructive-mission
description: Operating discipline for cross-cutting destructive missions (rebrand, package rename, runtime-state wipe, quarantine + replace). Use when the mission classifier returns architecture_change, runtime_refactor, or release_hardening — or when the mission risk level resolves to high or critical. Not for single-file edits or local feature additions.
---

# Destructive Mission Discipline

## Overview

Cross-cutting destructive missions fail differently from feature work: not from bad code, but from untracked decisions, unverified phase boundaries, and silent coordination gaps. The amaze runtime already has primitives for each failure mode: mission lifecycle templates, acceptance criteria, world model records, IRC, and memory. This skill is the contract that those primitives are engaged for this class of mission, not optional.

## When to Use

Use this skill when any of these are true:

- The mission classifier returns `architecture_change`, `runtime_refactor`, or `release_hardening`.
- The mission risk level resolves to `high` or `critical`.
- The mission spans 3 or more packages.
- The mission renames user-facing surface area.
- The mission wipes runtime state on disk.
- The mission has 4 or more phases.

Do not use this skill for single-file edits, local feature additions, typo fixes, or isolated refactors with no destructive blast radius.

## The 7 Conventions

### 1. Decision records at boot

First action: review existing project decision records for prior decisions on this surface area before planning.

### 2. Locked decisions as ADRs

Every locked decision — frozen choices at mission start plus any decision-worthy event later — is recorded as a `MissionWorldModelRecord` with `kind: "claim"` and `source: "decision"`. Populate `mission.decisionId` so `LIFECYCLE_TEMPLATES[intent].requireDecisionRecord` is satisfied. Never override a locked decision unilaterally; mark it `supersededBy` and create a new record.

### 3. Phase Close Contract is verifiable, not narrative

Declare phases up front via `runtime.declarePhases`. Each `MissionPhase` carries `acceptanceCriteria: AcceptanceCriterion[]` using deterministic kinds: `scope-include`, `file-exists`, `command-exit`, `command-output`, and `lsp-clean`. Avoid `manual` and `llm-judged` for gating because they return `uncertain` by default. `runtime.verifyPhase` must return pass before moving on, and `runtime.complete` blocks unless every declared phase is verified.

### 4. Plan-step edges encode invariants, not just order

Use `MissionPlanStepEdge` with `kind`:

- `depends-on` — must run after
- `must-precede` — must run before (asymmetric ordering)
- `produces` — this step emits an artifact a sibling consumes
- `behavior-change` — observable user-visible behavior shift (needs ADR)
- `needs-decision` — blocked until a `MissionWorldModelRecord(source="decision")` exists

When fanning out subagents, tasks linked by `produces` or `must-precede` belong in the same `task` call until the dispatcher enforces this. Do not split them across parallel fan-out batches.

### 5. IRC is mandatory for cross-task assumptions

Subagents in a fan-out share an IRC channel. Cross-task questions go to peers (`to: "all"` for discovery, specific id for handoff) before the subagent picks unilaterally. The `irc` tool prompt (`prompts/tools/irc.md`) is non-optional reading for orchestrator and subagents.

### 6. Proposal-before-mutation is the hard gate

`LIFECYCLE_TEMPLATES[architecture_change|runtime_refactor].requireProposalBeforeMutation === true`. The `MissionPolicyGate` blocks every mutation tool until `mission.proposalId` is attached via `runtime.attachProposal`. Build the proposal during Discovery, then attach it when the human approves.

### 7. Rollback anchor per destructive phase

Before each phase begins mutation, record a `MissionRollbackRecord(targetType: "file"|"decision"|"proposal", snapshotRef: <git-ref-or-snapshot>)`. If `verifyPhase` returns fail, the operator has a single command to back out without manual archaeology.

## Common Failure Modes

| Failure mode | Fix |
| --- | --- |
| Mission classifies as `code_change` | Update the objective text to include rebrand/quarantine/wipe/rename keywords (see `policy/intent.ts`). |
| Phase marked `done` without `runtime.verifyPhase` | `close()` rejects; either run verification or invoke `force: true` with explicit human reason. |
| Cross-task assumption picked unilaterally | Required to IRC `to: "all"` first; the destructive-mission-discipline rule fires if missing. |
| Prior decisions not reviewed at session start | Prior decisions silently absent; inspect MissionWorldModelRecord entries before planning. |
| Mission complete attempted with phases unverified | Throws `MissionAcceptanceFailureError` per the gate in `mission-runtime.ts`. |

## Verification

- [ ] Existing project decision records reviewed at session start
- [ ] All locked decisions recorded as `MissionWorldModelRecord(source="decision")`
- [ ] Every phase declared with deterministic acceptance criteria
- [ ] `MissionPlanStepEdge`s populated for cross-task invariants
- [ ] IRC channel established for every fan-out
- [ ] `proposalId` attached before any mutation
- [ ] Rollback anchor recorded before each destructive phase
