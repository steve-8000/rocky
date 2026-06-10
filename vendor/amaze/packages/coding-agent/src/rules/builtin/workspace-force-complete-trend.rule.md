---
id: workspace-force-complete-trend
name: Workspace force-complete trend
group: verifier-discipline
severity: high
trust: built-in
fileTypes: []
inherits: []
---

# Description
A high force-complete rate across the workspace means acceptance verification is being bypassed too often.

# Detection

```detect
scan: workspace
match: $.type == "goal.complete" && $.verdict == "force"
aggregate: count
window: { last: 500, type: "goal.complete" }
check: $count / $windowSize > thresholds.maxForceCompleteRate
thresholds:
  maxForceCompleteRate: 0.1
```

# Examples
- Multiple sessions force-complete goals instead of fixing failed verifier criteria.

# How to Improve
Use verifier feedback to repair failing criteria and reserve force completion for explicit human overrides.
