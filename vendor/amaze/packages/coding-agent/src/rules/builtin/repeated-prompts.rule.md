---
id: repeated-prompts
name: Repeated prompt tool calls
group: interaction-discipline
severity: warning
trust: built-in
fileTypes: []
inherits: []
---

# Description
Repeated ask-tool calls indicate the agent is asking for information it should derive from tools or existing context.

# Detection

```detect
scan: events
match: $.type == "tool.call" && $.tool == "ask"
aggregate: count
window: { last: 50, type: "tool.call" }
check: $count > thresholds.maxDuplicate
thresholds:
  maxDuplicate: 1
```

# Examples
- Multiple ask-tool calls appear in the last 50 tool calls.

# How to Improve
Use repository, tool, or context lookups before asking the user for factual information.
