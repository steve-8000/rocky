import { describe, expect, it } from "bun:test";
import { computeMetric } from "../../src/metrics";
import type { SessionEvent } from "../../src/observability";

function subagentStart(taskId: string, isolated: boolean, hasContract: boolean): SessionEvent {
	return {
		type: "subagent.start",
		sessionId: "s",
		ts: 1,
		taskId,
		role: "task",
		isolated,
		hasContract,
	};
}

describe("subagent.contractAdoption", () => {
	it("counts contract-bearing starts independently of isolation", () => {
		const events: SessionEvent[] = [
			subagentStart("t1", true, true),
			subagentStart("t2", false, true),
			subagentStart("t3", true, false),
			subagentStart("t4", false, false),
			subagentStart("t5", true, true),
		];

		expect(computeMetric("subagent.contractAdoption", events).value).toBe(0.6);
	});
});
