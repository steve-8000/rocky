/**
 * Self-improvement loop orchestrator tests — proves the observe→analyze→propose cycle
 * is actually closed (a firing rule produces a stored proposal), deduped, and that
 * rule-derived proposals are NEVER auto-evaluated/applied (they require human/review).
 */
import { describe, expect, it } from "bun:test";
import { runObjectiveLoopOnce } from "../../src/learning/loop";
import { ProposalStore } from "../../src/learning/store";
import type { EvalReport } from "../../src/learning/types";
import type { SessionEvent } from "../../src/observability";
import type { Rule } from "../../src/rules";

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
	description: "Force-completing goals bypasses acceptance verifier.",
	examples: "-",
	howToImprove: "Use the revision loop.",
};

function goalComplete(index: number, verdict: "pass" | "force"): SessionEvent {
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

/** 200 goal.complete events, `forceCount` of them force-completed (well over 5%). */
function firingEvents(forceCount: number): SessionEvent[] {
	return Array.from({ length: 200 }, (_, i) => goalComplete(i, i < forceCount ? "force" : "pass"));
}

describe("runObjectiveLoopOnce — closing the self-improvement loop", () => {
	it("generates a proposal from a firing rule and persists it as pending", async () => {
		const store = new ProposalStore(":memory:");
		try {
			const result = await runObjectiveLoopOnce({
				rules: [forceCompleteRule],
				events: firingEvents(40), // 20% force → fires
				store,
			});
			expect(result.created.length).toBe(1);
			const proposal = result.created[0];
			expect((proposal.provenance as { ruleId?: string }).ruleId).toBe("force-complete-rate");
			expect(proposal.status).toBe("pending");
			// Persisted and queryable.
			expect(store.listByStatus("pending").length).toBe(1);
		} finally {
			store.close();
		}
	});

	it("does not fire when the rule's threshold is not met", async () => {
		const store = new ProposalStore(":memory:");
		try {
			const result = await runObjectiveLoopOnce({
				rules: [forceCompleteRule],
				events: firingEvents(2), // 1% force → below 5% threshold
				store,
			});
			expect(result.created.length).toBe(0);
		} finally {
			store.close();
		}
	});

	it("dedups: a rule with a still-pending proposal does not spawn another", async () => {
		const store = new ProposalStore(":memory:");
		try {
			const first = await runObjectiveLoopOnce({ rules: [forceCompleteRule], events: firingEvents(40), store });
			expect(first.created.length).toBe(1);
			const second = await runObjectiveLoopOnce({ rules: [forceCompleteRule], events: firingEvents(40), store });
			expect(second.created.length).toBe(0);
			expect(second.skippedDuplicates).toBe(1);
			expect(store.listByStatus("pending").length).toBe(1);
		} finally {
			store.close();
		}
	});

	it("NEVER auto-evaluates rule-derived proposals (they require human/review)", async () => {
		const store = new ProposalStore(":memory:");
		let evalCalls = 0;
		const evaluate = async (): Promise<EvalReport> => {
			evalCalls++;
			return { passed: true, stage: "done", signals: {}, durationMs: 0, patchHash: "x" };
		};
		try {
			const result = await runObjectiveLoopOnce({
				rules: [forceCompleteRule],
				events: firingEvents(40),
				store,
				evaluate,
			});
			expect(result.created.length).toBe(1);
			// Rule-derived proposals are gated human-required/review, never auto.
			expect(result.created[0].gate === "human-required" || result.created[0].gate === "review").toBe(true);
			expect(result.autoEvaluated).toBe(0);
			expect(evalCalls).toBe(0);
		} finally {
			store.close();
		}
	});

	it("is resilient: a throwing evaluate never aborts the pass", async () => {
		const store = new ProposalStore(":memory:");
		try {
			const result = await runObjectiveLoopOnce({
				rules: [forceCompleteRule],
				events: firingEvents(40),
				store,
				evaluate: async () => {
					throw new Error("eval boom");
				},
			});
			// Proposal still created despite the (unreached, non-auto) evaluate.
			expect(result.created.length).toBe(1);
		} finally {
			store.close();
		}
	});
});
