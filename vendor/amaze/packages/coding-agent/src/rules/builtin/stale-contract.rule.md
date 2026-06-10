---
id: stale-contract
name: Subagent started with stale contract
group: subagent-discipline
severity: high
trust: built-in
fileTypes: []
inherits: []
---

# Description
A subagent that starts from an already-stale contract can mutate files against an obsolete parent goal.

# Detection

```detect
scan: events
match: $.type == "subagent.start" && $.contractRevision != null
aggregate: count
window: { last: 50, type: "subagent.start" }
check: $count > 0
```

# Examples
- A subagent.start event includes a non-null contractRevision placeholder in the last 50 starts.

# How to Improve
Stop stale workers immediately and re-issue delegation from the current parent goal revision.
