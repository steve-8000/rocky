import { describe, expect, it } from "bun:test";
import { computeMetric } from "../../src/metrics";
import type { SessionEvent } from "../../src/observability";

const baseGoal = { sessionId: "s", ts: 1, goalId: "g", failedCount: 0, uncertainCount: 0 } as const;
const events: SessionEvent[] = [
	{ type: "goal.complete", ...baseGoal, goalId: "g1", verdict: "pass" },
	{ type: "goal.complete", ...baseGoal, goalId: "g2", verdict: "force" },
	{ type: "goal.complete", ...baseGoal, goalId: "g3", verdict: "fail" },
	{ type: "subagent.start", sessionId: "s", ts: 2, taskId: "t1", role: "r", isolated: true, hasContract: true },
	{ type: "subagent.start", sessionId: "s", ts: 3, taskId: "t2", role: "r", isolated: false, hasContract: false },
	{ type: "subagent.end", sessionId: "s", ts: 4, taskId: "t1", verdict: "pass", changedFiles: 1, revisions: 1 },
	{
		type: "subagent.end",
		sessionId: "s",
		ts: 5,
		taskId: "t2",
		verdict: "fail",
		changedFiles: 0,
		revisions: 2,
		reason: "no-yield",
	} as SessionEvent,
	{ type: "subagent.end", sessionId: "s", ts: 6, taskId: "t3", verdict: "fail", changedFiles: 0, revisions: 0 },
	{ type: "memory.recall", sessionId: "s", ts: 7, query: "q1", hits: 3, usedHits: 2 },
	{ type: "memory.recall", sessionId: "s", ts: 8, query: "q2", hits: 1, usedHits: 1 },
	{ type: "memory.write", sessionId: "s", ts: 9, memoryType: "fact", status: "active" },
	{ type: "memory.write", sessionId: "s", ts: 10, memoryType: "fact", status: "superseded" },
	{ type: "memory.write", sessionId: "s", ts: 11, memoryType: "fact", status: "quarantined" },
	{ type: "prompt.cache", sessionId: "s", ts: 12, readTokens: 1, writeTokens: 2, missReason: "tail-change" },
	{ type: "prompt.cache", sessionId: "s", ts: 13, readTokens: 1, writeTokens: 2, missReason: "tool-change" },
	{ type: "turn.end", sessionId: "s", ts: 14, turn: 1, usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 } },
	{ type: "turn.end", sessionId: "s", ts: 15, turn: 2, usage: { total: 20 } },
	{
		type: "verifier.criterion",
		sessionId: "s",
		ts: 16,
		goalId: "g2",
		criterionId: "c1",
		status: "fail",
		durationMs: 1,
	},
	{
		type: "verifier.criterion",
		sessionId: "s",
		ts: 17,
		goalId: "g3",
		criterionId: "c2",
		status: "fail",
		durationMs: 1,
	},
	{
		type: "verifier.criterion",
		sessionId: "s",
		ts: 18,
		goalId: "g1",
		criterionId: "c3",
		status: "pass",
		durationMs: 1,
	},
];

describe("default metric definitions", () => {
	it.each([
		["goal.completion.passRate", 1 / 3],
		["goal.forceCompleteRate", 1 / 3],
		["subagent.contractAdoption", 1 / 2],
		["subagent.revisionSuccess", 1 / 2],
		["subagent.noYieldRate", 1 / 3],
		["memory.hitPrecision", 3 / 4],
		["memory.staleRate", 2 / 3],
		["prompt.cacheChurn", 1 / 2],
		// readTokens (1 + 1) over (readTokens + writeTokens) ((1+2) + (1+2)) = 2 / 6
		["prompt.cacheReadRatio", 1 / 3],
		["cost.perAcceptedGoal", 40],
		["verifier.bypassRate", 1 / 2],
	])("computes %s", (name, expected) => {
		expect(computeMetric(name, events).value).toBe(expected);
	});
});
