---
id: memory-low-precision
name: Low memory recall precision
group: memory-quality
severity: warning
trust: built-in
fileTypes: []
inherits: []
---

# Description
Low memory recall precision means retrieved memories are rarely used, adding noise to agent context.

# Detection

```detect
scan: events
match: $.type == "memory.recall"
aggregate: ratio $.usedHits / $.hits
window: { last: 100, type: "memory.recall" }
check: $ratio < thresholds.minPrecision
thresholds:
  minPrecision: 0.3
```

# Examples
- Fewer than thirty percent of recalled memory hits are used across the last 100 memory recalls.

# How to Improve
Improve memory indexing, scope filtering, or writeback quality so recalled entries are specific and actionable.
