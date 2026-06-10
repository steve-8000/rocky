import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/observability";
import { evaluateRule, type Rule, type RuleFinding } from "../../src/rules";

function memoryRecall(ts: number, hits: number, usedHits: number): SessionEvent {
	return { type: "memory.recall", sessionId: "session-a", ts, hits, usedHits } as SessionEvent;
}

function ratioRule(aggregate = "ratio $.usedHits / $.hits", check = "$ratio < thresholds.minPrecision"): Rule {
	return {
		id: "memory-low-precision",
		name: "Low memory recall precision",
		group: "memory-quality",
		severity: "warning",
		trust: "built-in",
		fileTypes: [],
		inherits: [],
		detect: {
			scan: "events",
			match: '$.type == "memory.recall"',
			aggregate,
			window: { last: 100, type: "memory.recall" },
			check,
			thresholds: { minPrecision: 0.5 },
		},
		description: "test rule",
		examples: "test example",
		howToImprove: "test improvement",
	};
}

function expectFinding(value: RuleFinding | RuleFinding[] | null): RuleFinding {
	expect(value).not.toBeNull();
	expect(value).not.toBeArray();
	return value as RuleFinding;
}

describe("ratio expression aggregates", () => {
	test("sums numerator and denominator expressions over memory recall events", () => {
		const finding = expectFinding(
			evaluateRule(ratioRule("ratio $.usedHits / $.hits", "$ratio <= thresholds.minPrecision"), [
				memoryRecall(1, 10, 2),
				memoryRecall(2, 5, 3),
				memoryRecall(3, 5, 5),
			]),
		);

		expect(finding).toMatchObject({
			ruleId: "memory-low-precision",
			severity: "warning",
			count: 0.5,
			windowSize: 3,
		});
	});

	test("returns zero for an empty denominator without producing NaN", () => {
		const finding = expectFinding(
			evaluateRule(ratioRule("ratio $.usedHits / $.hits", "$ratio == 0"), [memoryRecall(1, 0, 3)]),
		);

		expect(finding.count).toBe(0);
		expect(Number.isNaN(finding.count)).toBe(false);
	});

	test("returns a critical error finding for malformed aggregate strings", () => {
		expect(() => evaluateRule(ratioRule("ratio $.usedHits /"), [memoryRecall(1, 1, 1)])).not.toThrow();

		const finding = expectFinding(evaluateRule(ratioRule("ratio $.usedHits /"), [memoryRecall(1, 1, 1)]));
		expect(finding).toMatchObject({
			ruleId: "memory-low-precision",
			severity: "critical",
			count: 0,
			windowSize: 0,
		});
		expect(finding.message).toContain("ratio $.usedHits /");
	});
});
