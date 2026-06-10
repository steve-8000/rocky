---
id: destructive-mission-discipline
name: Destructive mission underway without coordination discipline
group: mission-discipline
severity: high
trust: built-in
fileTypes: []
inherits: []
---

# Description
Destructive missions need explicit coordination discipline as soon as the runtime classifies them as high risk.

# Detection

```detect
scan: events
match: $.type == "mission.classified" && ($.riskLevel == "high")
aggregate: count
window: { last: 50, type: "mission.classified" }
check: $count > 0
```

# Examples
- A mission.classified event reports high risk in the last 50 classifications.
- A destructive rebrand or quarantine mission is classified high risk and should immediately engage coordination gates.

# How to Improve
- Review existing project decision records before mutation so prior decisions on this surface are loaded.
- Declare phases up front via `MissionRuntime.declarePhases` and gate each phase close on `verifyPhase` returning pass.
- Use IRC (`irc` tool) for any cross-task assumption; broadcast assumptions with `to: "all"` and do not pick unilaterally.
- Record locked decisions as `MissionWorldModelRecord(source="decision")` so they survive restarts; populate `mission.decisionId` so `LIFECYCLE_TEMPLATES[mission.intent].requireDecisionRecord` is satisfied.
- Attach an approved proposal (`runtime.attachProposal`) before any mutation tool runs; `MissionPolicyGate` blocks mutation tools when `proposalId` is missing under `requireProposalBeforeMutation` intents.
- Use `MissionPlanStepEdge` (`kind: "produces"`, `"must-precede"`, `"behavior-change"`, or `"needs-decision"`) when planning so cross-task invariants are visible.
