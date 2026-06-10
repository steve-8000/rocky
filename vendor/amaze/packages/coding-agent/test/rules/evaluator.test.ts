import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/observability";
import { evaluateRule, type Rule, type RuleFinding } from "../../src/rules";

function expectFinding(value: RuleFinding | RuleFinding[] | null): RuleFinding {
	expect(value).not.toBeNull();
	expect(value).not.toBeArray();
	return value as RuleFinding;
}

const forceCompleteRule: Rule = {
	id: "force-complete-rate",
	name: "High force-complete rate",
	group: "verifier-discipline",
	severity: "warning",
	trust: "built-in",
	fileTypes: [],
	inherits: [],
	detect: {
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
	},
	description: "Force-completing goals bypasses acceptance verifier and risks self-contamination.",
	examples: '- session abc123 force-completed goal "refactor X" with 2 failing criteria',
	howToImprove: "Use revision loop or fix failing criteria; reserve force only for human override.",
};

function goalComplete(index: number, verdict: "pass" | "fail" | "force"): SessionEvent {
	return {
		type: "goal.complete",
		sessionId: `session-${index % 5}`,
		ts: index,
		goalId: `goal-${index}`,
		verdict,
		failedCount: verdict === "pass" ? 0 : 1,
		uncertainCount: 0,
	};
}

function turnStart(index: number): SessionEvent {
	return { type: "turn.start", sessionId: "session-noise", ts: index, turn: index };
}

function fixtureEvents(forceCount: number): SessionEvent[] {
	const goalEvents = Array.from({ length: 200 }, (_, index) =>
		goalComplete(index, index < forceCount ? "force" : "pass"),
	);
	return [turnStart(-1), ...goalEvents, turnStart(201)];
}

describe("evaluateRule", () => {
	test("finds force-complete rate over the typed last window", () => {
		const finding = expectFinding(evaluateRule(forceCompleteRule, fixtureEvents(20)));

		expect(finding).toMatchObject({
			ruleId: "force-complete-rate",
			severity: "warning",
			count: 20,
			windowSize: 200,
		});
		expect(finding.sampleEvents).toHaveLength(3);
		expect(finding.sampleEvents.every(event => event.type === "goal.complete" && event.verdict === "force")).toBe(
			true,
		);
		expect(finding.message).toContain("20 matching events in 200 event window");
	});

	test("returns null when no force-complete events match", () => {
		expect(evaluateRule(forceCompleteRule, fixtureEvents(0))).toBeNull();
	});

	test("threshold changes control whether a finding is emitted", () => {
		const relaxedRule: Rule = {
			...forceCompleteRule,
			detect: {
				...forceCompleteRule.detect,
				thresholds: { maxRate: 0.2 },
			},
		};

		expect(evaluateRule(relaxedRule, fixtureEvents(20))).toBeNull();
		expect(evaluateRule(forceCompleteRule, fixtureEvents(20))).not.toBeNull();
	});

	test("uses the first truthy dynamic severity branch", () => {
		const finding = expectFinding(evaluateRule(forceCompleteRule, fixtureEvents(40)));

		expect(finding.severity).toBe("high");
		expect(finding.count).toBe(40);
	});

	test("rejects unsupported scan targets", () => {
		const sessionRule: Rule = {
			...forceCompleteRule,
			detect: { ...forceCompleteRule.detect, scan: "sessions" as never },
		};

		expect(() => evaluateRule(sessionRule, fixtureEvents(20))).toThrow(/Unsupported rule scan/);
	});
});
