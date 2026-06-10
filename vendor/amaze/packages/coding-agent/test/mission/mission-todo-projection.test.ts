import { describe, expect, it } from "bun:test";
import type { Mission } from "@amaze/coding-agent/mission/core/mission";
import { projectMissionToTodoPhases } from "@amaze/coding-agent/mission/core/mission-todo-projection";

function mission(overrides: Partial<Mission>): Mission {
	return {
		id: "mission-1",
		title: "Mission",
		objective: "Deliver the change",
		mode: "auto",
		lifecycle: "created",
		riskLevel: "medium",
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

function phaseNamesFor(overrides: Partial<Mission>): string[] {
	return projectMissionToTodoPhases(mission(overrides)).map(phase => phase.name);
}

describe("projectMissionToTodoPhases", () => {
	it("projects architecture-change lifecycle requirements", () => {
		const phases = projectMissionToTodoPhases(
			mission({
				intent: "architecture_change",
				decisionId: "decision-1",
				tasks: [
					{ id: "task-1", title: "Design API", status: "pending" },
					{ id: "task-2", title: "Update callers", status: "completed" },
				],
			}),
		);

		expect(phases.map(phase => phase.name)).toEqual(["Frame", "Decision", "Regression", "Execution", "Verification"]);
		expect(phases[1]?.tasks[0]?.status).toBe("completed");
		expect(phases[2]?.tasks[0]?.status).toBe("pending");
		expect(phases[3]?.tasks.map(task => task.status)).toEqual(["pending", "completed"]);
		expect(phases[4]?.tasks[0]?.status).toBe("pending");
	});

	it("projects code-change missions without decision or regression phases", () => {
		const phases = projectMissionToTodoPhases(
			mission({
				intent: "code_change",
				tasks: [{ id: "task-1", title: "Implement", status: "completed" }],
				verification: { status: "pass", verdict: "pass", summary: "ok" },
			}),
		);

		expect(phases.map(phase => phase.name)).toEqual(["Frame", "Execution", "Verification"]);
		expect(phases[2]?.tasks[0]?.status).toBe("completed");
	});

	it("projects conversation missions without lifecycle gate phases", () => {
		expect(phaseNamesFor({ intent: "conversation" })).toEqual(["Frame"]);
		expect(phaseNamesFor({})).toEqual(["Frame"]);
	});

	it("projects runtime-refactor lifecycle requirements", () => {
		expect(phaseNamesFor({ intent: "runtime_refactor" })).toEqual([
			"Frame",
			"Decision",
			"Regression",
			"Verification",
		]);
	});
});
