import { describe, expect, it } from "bun:test";
import { computeMetric, registerMetric } from "../../src/metrics/engine";
import type { SessionEvent } from "../../src/observability";

const events: SessionEvent[] = [
	{ type: "turn.start", sessionId: "s", ts: 10, turn: 1 },
	{ type: "goal.complete", sessionId: "s", ts: 20, goalId: "g1", verdict: "pass", failedCount: 0, uncertainCount: 0 },
	{ type: "goal.complete", sessionId: "s", ts: 30, goalId: "g2", verdict: "fail", failedCount: 1, uncertainCount: 0 },
	{ type: "goal.complete", sessionId: "s", ts: 40, goalId: "g3", verdict: "pass", failedCount: 0, uncertainCount: 0 },
];

describe("metric engine", () => {
	it("registers and computes a metric over matching event types", () => {
		registerMetric({
			name: "test.passRate",
			eventTypes: ["goal.complete"],
			initial: () => ({ pass: 0, total: 0 }),
			reducer: (state, event) => {
				if (event.type !== "goal.complete") return state;
				return { pass: state.pass + (event.verdict === "pass" ? 1 : 0), total: state.total + 1 };
			},
			finalize: state => state.pass / state.total,
		});

		const result = computeMetric("test.passRate", events);

		expect(result.value).toBe(2 / 3);
		expect(result.sampleN).toBe(3);
		expect(result.window).toEqual({ total: 4, start: 10, end: 40, last: undefined, since: undefined });
	});

	it("applies last and since windows before filtering event types", () => {
		registerMetric({
			name: "test.countGoals",
			eventTypes: ["goal.complete"],
			initial: () => 0,
			reducer: state => state + 1,
			finalize: value => ({ value, meta: { unit: "events" } }),
		});

		const result = computeMetric("test.countGoals", events, { window: { last: 3, since: 35 } });

		expect(result).toEqual({
			name: "test.countGoals",
			value: 1,
			meta: { unit: "events" },
			sampleN: 1,
			window: { total: 1, start: 40, end: 40, last: 3, since: 35 },
		});
	});
});
