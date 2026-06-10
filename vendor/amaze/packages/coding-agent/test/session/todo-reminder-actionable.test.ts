import { describe, expect, it } from "bun:test";
import {
	collectIncompleteByPhase,
	isMissionTerminal,
	selectAgentActionableTodos,
} from "@amaze/coding-agent/session/todo-reminder-actionable";
import type { TodoPhase } from "@amaze/coding-agent/tools/todo-write";

const phase = (
	name: string,
	tasks: Array<[string, "pending" | "in_progress" | "completed" | "abandoned"]>,
): TodoPhase => ({
	name,
	tasks: tasks.map(([content, status]) => ({ content, status })),
});

describe("collectIncompleteByPhase", () => {
	it("drops completed/abandoned tasks and empty phases", () => {
		const phases: TodoPhase[] = [
			phase("Frame", [["Objective: foo", "completed"]]),
			phase("Execution", [
				["alpha", "pending"],
				["beta", "completed"],
				["gamma", "in_progress"],
			]),
			phase("Verification", [["Verification verdict", "abandoned"]]),
		];
		expect(collectIncompleteByPhase(phases)).toEqual([
			{
				name: "Execution",
				tasks: [
					{ content: "alpha", status: "pending" },
					{ content: "gamma", status: "in_progress" },
				],
			},
		]);
	});

	it("returns empty when nothing is incomplete", () => {
		expect(collectIncompleteByPhase([phase("Execution", [["a", "completed"]])])).toEqual([]);
	});
});

describe("selectAgentActionableTodos", () => {
	const incomplete = [
		{ name: "Frame", tasks: [{ content: "Objective: foo", status: "pending" as const }] },
		{ name: "Decision", tasks: [{ content: "Decision record", status: "pending" as const }] },
		{ name: "Regression", tasks: [{ content: "Regression contract", status: "pending" as const }] },
		{ name: "Execution", tasks: [{ content: "alpha", status: "in_progress" as const }] },
		{ name: "Verification", tasks: [{ content: "Verification verdict", status: "pending" as const }] },
	];

	it("returns all incomplete rows when no mission is active", () => {
		const out = selectAgentActionableTodos(incomplete, false);
		expect(out.map(t => t.content)).toEqual([
			"Objective: foo",
			"Decision record",
			"Regression contract",
			"alpha",
			"Verification verdict",
		]);
	});

	it("returns only Execution rows when a mission is active (projection-only filter)", () => {
		const out = selectAgentActionableTodos(incomplete, true);
		expect(out).toEqual([{ content: "alpha", status: "in_progress" }]);
	});

	it("returns empty when a mission is active and only synthetic projection slots remain", () => {
		const onlySynthetic = incomplete.filter(p => p.name !== "Execution");
		expect(selectAgentActionableTodos(onlySynthetic, true)).toEqual([]);
	});

	it("returns empty when nothing is incomplete", () => {
		expect(selectAgentActionableTodos([], false)).toEqual([]);
		expect(selectAgentActionableTodos([], true)).toEqual([]);
	});
});

describe("isMissionTerminal", () => {
	it("returns true for completed / cancelled / blocked / rolled_back", () => {
		expect(isMissionTerminal({ lifecycle: "completed" })).toBe(true);
		expect(isMissionTerminal({ lifecycle: "cancelled" })).toBe(true);
		expect(isMissionTerminal({ lifecycle: "blocked" })).toBe(true);
		expect(isMissionTerminal({ lifecycle: "rolled_back" })).toBe(true);
	});

	it("returns false for in-flight lifecycles", () => {
		expect(isMissionTerminal({ lifecycle: "created" })).toBe(false);
		expect(isMissionTerminal({ lifecycle: "executing" })).toBe(false);
		expect(isMissionTerminal({ lifecycle: "verifying" })).toBe(false);
	});
});
