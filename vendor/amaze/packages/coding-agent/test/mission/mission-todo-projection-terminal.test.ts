import { describe, expect, test } from "bun:test";
import type { Mission } from "../../src/mission/core/mission";
import { projectMissionToTodoPhases } from "../../src/mission/core/mission-todo-projection";

function mission(overrides: Partial<Mission>): Mission {
	return {
		id: "m1",
		title: "t",
		objective: "o",
		mode: "interactive",
		lifecycle: "executing",
		riskLevel: "medium",
		intent: "architecture_change",
		constraints: [],
		acceptanceCriteria: [],
		budget: { tokenBudget: 0, tokensUsed: 0 },
		contextBudget: { maxContextTokens: 0, contextTokensUsed: 0 },
		tasks: [],
		evidenceRefs: [],
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		...overrides,
	};
}

function syntheticStatuses(overrides: Partial<Mission>) {
	const phases = projectMissionToTodoPhases(mission(overrides));
	return {
		decision: phases.find(phase => phase.name === "Decision")?.tasks[0]?.status,
		regression: phases.find(phase => phase.name === "Regression")?.tasks[0]?.status,
		verification: phases.find(phase => phase.name === "Verification")?.tasks[0]?.status,
	};
}

describe("projectMissionToTodoPhases terminal synthetic items", () => {
	test("live mission keeps synthetic items pending", () => {
		expect(syntheticStatuses({ lifecycle: "executing" })).toEqual({
			decision: "pending",
			regression: "pending",
			verification: "pending",
		});
	});

	test("completed mission marks unrecorded synthetic items as completed", () => {
		expect(syntheticStatuses({ lifecycle: "completed" })).toEqual({
			decision: "completed",
			regression: "completed",
			verification: "completed",
		});
		expect(syntheticStatuses({ lifecycle: "completed", decisionId: "d1" }).decision).toBe("completed");
	});

	test("cancelled mission marks unrecorded synthetic items as abandoned", () => {
		expect(syntheticStatuses({ lifecycle: "cancelled" })).toEqual({
			decision: "abandoned",
			regression: "abandoned",
			verification: "abandoned",
		});
	});

	test("rolled_back mission marks unrecorded synthetic items as abandoned", () => {
		expect(syntheticStatuses({ lifecycle: "rolled_back" })).toEqual({
			decision: "abandoned",
			regression: "abandoned",
			verification: "abandoned",
		});
	});

	test("blocked mission marks unrecorded synthetic items as abandoned", () => {
		expect(syntheticStatuses({ lifecycle: "blocked" })).toEqual({
			decision: "abandoned",
			regression: "abandoned",
			verification: "abandoned",
		});
	});

	test("pre-existing decisionId still wins over terminal status", () => {
		expect(syntheticStatuses({ lifecycle: "cancelled", decisionId: "d1" })).toEqual({
			decision: "completed",
			regression: "abandoned",
			verification: "abandoned",
		});
	});

	test("pre-existing verification verdict still wins", () => {
		expect(
			syntheticStatuses({ lifecycle: "completed", verification: { verdict: "fail", status: "fail", summary: "x" } }),
		).toEqual({
			decision: "completed",
			regression: "completed",
			verification: "abandoned",
		});
	});
});
