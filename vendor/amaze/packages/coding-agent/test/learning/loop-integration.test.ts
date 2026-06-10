/**
 * Closed-loop integration: a `goal.complete` event on the session bus drives the wiring,
 * which runs the analyzer (rules → proposals) and lands a review-gated proposal in the
 * store. Proves the observe → analyze → propose loop is actually CONNECTED end to end
 * (not just unit-tested pieces).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runObjectiveLoopOnce } from "../../src/learning/loop";
import { attachSelfImprovementLoop } from "../../src/learning/loop-wiring";
import { ProposalStore } from "../../src/learning/store";
import type { SessionEvent } from "../../src/observability";
import { EventBus } from "../../src/observability/event-bus";
import type { Rule } from "../../src/rules";

const FLAG = "AMAZE_SELF_IMPROVE_LOOP";
let prev: string | undefined;
beforeEach(() => {
	prev = process.env[FLAG];
	process.env[FLAG] = "1";
});
afterEach(() => {
	if (prev === undefined) delete process.env[FLAG];
	else process.env[FLAG] = prev;
});

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
	description: "-",
	examples: "-",
	howToImprove: "-",
};

function firingEvents(forceCount: number): SessionEvent[] {
	return Array.from(
		{ length: 200 },
		(_, i) =>
			({
				type: "goal.complete",
				sessionId: `s-${i % 5}`,
				ts: i,
				goalId: `g-${i}`,
				verdict: i < forceCount ? "force" : "pass",
				failedCount: i < forceCount ? 1 : 0,
				uncertainCount: 0,
			}) as SessionEvent,
	);
}

describe("self-improvement loop — closed end to end", () => {
	it("goal.complete on the bus → analyzer → review-gated proposal persisted", async () => {
		const store = new ProposalStore(":memory:");
		const bus = new EventBus();
		const off = attachSelfImprovementLoop({
			eventBus: bus,
			// Real analyzer logic, in-memory rules/events/store (no disk I/O).
			analyze: () => runObjectiveLoopOnce({ rules: [forceCompleteRule], events: firingEvents(40), store }),
		});
		try {
			expect(store.listByStatus("pending").length).toBe(0);
			bus.emit({
				type: "goal.complete",
				sessionId: "s",
				ts: 999,
				goalId: "g",
				verdict: "force",
				failedCount: 1,
				uncertainCount: 0,
			});
			// Let the fire-and-forget pass complete.
			await new Promise(r => setTimeout(r, 10));

			const pending = store.listByStatus("pending");
			expect(pending.length).toBe(1);
			expect((pending[0].provenance as { ruleId?: string }).ruleId).toBe("force-complete-rate");
			// Closed loop is safe: the proposal is review/human gated, never auto-applied.
			expect(pending[0].gate === "review" || pending[0].gate === "human-required").toBe(true);
			expect(pending[0].status).toBe("pending");
		} finally {
			off();
			store.close();
		}
	});
});
