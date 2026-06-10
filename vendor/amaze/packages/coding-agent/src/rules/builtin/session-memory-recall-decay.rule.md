---
id: session-memory-recall-decay
name: Session memory recall decay
group: memory-quality
severity: warning
trust: built-in
fileTypes: []
inherits: []
---

# Description
Low memory recall precision across a session means retrieved memories are rarely used and likely add distracting context.

# Detection

```detect
scan: session
match: $.type == "memory.recall" && $.hits > 0 && $.usedHits / $.hits < thresholds.minPrecision
aggregate: count
window: { last: 500 }
check: $count > thresholds.maxLowPrecisionRecalls
thresholds:
  minPrecision: 0.25
  maxLowPrecisionRecalls: 2
```

# Examples
- A session repeatedly recalls memory, but few recalled hits are used by the agent.

# How to Improve
Tighten memory retrieval scope and remove stale or low-signal memories so recalled context is actionable.
