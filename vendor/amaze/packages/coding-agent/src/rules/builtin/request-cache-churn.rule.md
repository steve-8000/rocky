---
id: request-cache-churn
name: Request cache churn
group: cache-efficiency
severity: warning
trust: built-in
fileTypes: []
inherits: []
---

# Description
High tail-change cache churn within a single request means prompt tail instability is defeating cache reuse.

# Detection

```detect
scan: request
match: $.type == "cache.lookup" && $.missReason == "tail-change"
aggregate: count
window: { last: 500 }
check: $count / $windowSize > thresholds.maxTailChangeRate
thresholds:
  maxTailChangeRate: 0.4
```

# Examples
- A turn repeatedly misses cache because the request tail changes between otherwise similar tool calls.

# How to Improve
Keep stable prompt prefixes and avoid unnecessary request-tail churn inside a single turn.
