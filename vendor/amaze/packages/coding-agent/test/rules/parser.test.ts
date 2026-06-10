import { describe, expect, test } from "bun:test";
import { parseRuleMarkdown } from "../../src/rules";

const FORCE_COMPLETE_RATE = `---
id: force-complete-rate
name: High force-complete rate
group: verifier-discipline
severity: warning
trust: built-in
fileTypes: []
inherits: []
---

# Description
Force-completing goals bypasses acceptance verifier and risks self-contamination.

# Detection

\`\`\`detect
scan: events
match: $.type == "goal.complete" && $.verdict == "force"
aggregate: count
window: { last: 200, type: "goal.complete" }
check: $count / $windowSize > thresholds.maxRate
thresholds:
  maxRate: 0.05
severity:
  if: $count / $windowSize > 0.15 then "high"
  else if: $count / $windowSize > 0.05 then "warning"
\`\`\`

# Examples
- session abc123 force-completed goal "refactor X" with 2 failing criteria

# How to Improve
Use revision loop or fix failing criteria; reserve force only for human override.
`;

describe("parseRuleMarkdown", () => {
	test("parses the force-complete-rate example", () => {
		const rule = parseRuleMarkdown(FORCE_COMPLETE_RATE);

		expect(rule.id).toBe("force-complete-rate");
		expect(rule.name).toBe("High force-complete rate");
		expect(rule.group).toBe("verifier-discipline");
		expect(rule.severity).toBe("warning");
		expect(rule.trust).toBe("built-in");
		expect(rule.fileTypes).toEqual([]);
		expect(rule.inherits).toEqual([]);
		expect(rule.detect).toEqual({
			scan: "events",
			match: '$.type == "goal.complete" && $.verdict == "force"',
			aggregate: "count",
			window: { last: 200, type: "goal.complete" },
			check: "$count / $windowSize > thresholds.maxRate",
			thresholds: { maxRate: 0.05 },
			severity: {
				if: '$count / $windowSize > 0.15 then "high"',
				"else if": '$count / $windowSize > 0.05 then "warning"',
			},
		});
		expect(rule.description).toBe(
			"Force-completing goals bypasses acceptance verifier and risks self-contamination.",
		);
		expect(rule.examples).toBe('- session abc123 force-completed goal "refactor X" with 2 failing criteria');
		expect(rule.howToImprove).toBe(
			"Use revision loop or fix failing criteria; reserve force only for human override.",
		);
	});

	test("rejects missing frontmatter", () => {
		expect(() => parseRuleMarkdown("# Description\nNo metadata\n\n```detect\nscan: events\n```")).toThrow(
			/frontmatter/,
		);
	});

	test("rejects missing detect block", () => {
		expect(() => parseRuleMarkdown("---\nid: x\n---\n# Description\nNo detect")).toThrow(/detect block/);
	});
});
