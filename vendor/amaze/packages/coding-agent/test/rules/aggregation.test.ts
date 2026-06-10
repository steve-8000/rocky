import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/observability";
import { evaluateRule, type Rule, type RuleFinding } from "../../src/rules";

function expectFindings(value: RuleFinding | RuleFinding[] | null): RuleFinding[] {
	expect(value).toBeArray();
	return value as RuleFinding[];
}

function event(type: string, sessionId: string, ts: number, extra: Record<string, unknown> = {}): SessionEvent {
	return { type, sessionId, ts, ...extra } as SessionEvent;
}

function rule(scan: Rule["detect"]["scan"], match: string, check = "$count > 0"): Rule {
	return {
		id: `${scan}-aggregation`,
		name: `${scan} aggregation`,
		group: "test",
		severity: "warning",
		trust: "built-in",
		fileTypes: [],
		inherits: [],
		detect: {
			scan,
			match,
			aggregate: "count",
			check,
		},
		description: "test rule",
		examples: "test example",
		howToImprove: "test improvement",
	};
}

describe("rule aggregation scans", () => {
	test("session fires once per matching session", () => {
		const findings = expectFindings(
			evaluateRule(rule("session", '$.type == "hit"'), [
				event("hit", "session-a", 1),
				event("hit", "session-a", 2),
				event("miss", "session-b", 3),
			]),
		);

		expect(findings).toBeArrayOfSize(1);
		expect(findings[0]).toMatchObject({ count: 2, windowSize: 2 });
	});

	test("request fires once per matching turn", () => {
		const findings = expectFindings(
			evaluateRule(rule("request", '$.type == "cache" && $.missReason == "tail-change"'), [
				event("session.start", "session-a", 0),
				event("turn.start", "session-a", 1, { turn: 1 }),
				event("cache", "session-a", 2, { missReason: "tail-change" }),
				event("turn.end", "session-a", 3, { turn: 1 }),
				event("turn.start", "session-a", 4, { turn: 2 }),
				event("cache", "session-a", 5, { missReason: "stable" }),
				event("turn.end", "session-a", 6, { turn: 2 }),
				event("turn.start", "session-a", 7, { turn: 3 }),
				event("cache", "session-a", 8, { missReason: "tail-change" }),
				event("cache", "session-a", 9, { missReason: "tail-change" }),
				event("turn.end", "session-a", 10, { turn: 3 }),
				event("cache", "session-a", 11, { missReason: "tail-change" }),
			]),
		);

		expect(findings).toBeArrayOfSize(2);
		expect(findings.map(finding => finding.count)).toEqual([1, 2]);
	});

	test("workspace fires once across all events", () => {
		const findings = expectFindings(
			evaluateRule(rule("workspace", '$.type == "force"'), [
				event("force", "session-a", 1),
				event("force", "session-b", 2),
				event("pass", "session-c", 3),
			]),
		);

		expect(findings).toBeArrayOfSize(1);
		expect(findings[0]).toMatchObject({ count: 2, windowSize: 3 });
	});

	test("empty request groups do not fire", () => {
		const findings = evaluateRule(rule("request", '$.type == "cache"', "$count / $windowSize > 0"), [
			event("session.start", "session-a", 0),
			event("cache", "session-a", 1),
		]);

		expect(findings).toEqual([]);
	});
});
