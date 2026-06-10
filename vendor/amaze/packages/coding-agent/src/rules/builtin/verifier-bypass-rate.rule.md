---
id: verifier-bypass-rate
name: Verifier bypass with failing criteria
group: verifier-discipline
severity: high
trust: built-in
fileTypes: []
inherits: []
---

# Description
Force-completing goals while criteria are failing bypasses the verifier at the point it is most needed.

# Detection

```detect
scan: events
match: $.type == "goal.complete" && $.verdict == "force" && $.failedCount > 0
aggregate: count
window: { last: 100, type: "goal.complete" }
check: $count / $windowSize > thresholds.maxBypass
thresholds:
  maxBypass: 0.02
```

# Examples
- More than two percent of the last 100 completed goals were forced despite failed criteria.

# How to Improve
Resolve failed criteria before completion; only bypass verification when an explicit human override requires it.
