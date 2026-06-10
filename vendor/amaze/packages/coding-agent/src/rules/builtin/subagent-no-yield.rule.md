---
id: subagent-no-yield
name: Subagents ending without yield
group: subagent-discipline
severity: warning
trust: built-in
fileTypes: []
inherits: []
---

# Description
Subagents that fail to yield leave delegated work without a durable result for the parent agent.

# Detection

```detect
scan: events
match: $.type == "subagent.end" && $.verdict == "fail" && $.reason == "no-yield"
aggregate: count
window: { last: 100, type: "subagent.end" }
check: $count / $windowSize > 0.05
thresholds:
  maxRate: 0.05
```

# Examples
- More than five of the last 100 subagent runs ended with verdict fail and reason no-yield.

# How to Improve
Ensure each delegated worker returns exactly one yield result after completing its assigned deliverable.
