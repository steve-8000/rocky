---
id: force-complete-rate
name: High force-complete rate
group: verifier-discipline
severity: warning
trust: built-in
fileTypes: []
inherits: []
---

# Description
Force-completing goals bypasses acceptance verification and risks accepting incomplete work.

# Detection

```detect
scan: events
match: $.type == "goal.complete" && $.verdict == "force"
aggregate: count
window: { last: 200, type: "goal.complete" }
check: $count / $windowSize > thresholds.maxRate
thresholds:
  maxRate: 0.05
severity:
  if: $count / $windowSize > 0.15 then "high"
  else if: $count / $windowSize > thresholds.maxRate then "warning"
```

# Examples
- More than five percent of the last 200 completed goals were force-completed.
- More than fifteen percent of the last 200 completed goals were force-completed, escalating severity to high.

# How to Improve
Fix failing acceptance criteria or revise the goal instead of forcing completion.
