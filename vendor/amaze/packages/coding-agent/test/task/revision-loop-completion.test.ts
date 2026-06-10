import { describe, expect, it } from "bun:test";
import type { SubagentContract } from "../../src/subagent/contract";
import { executeContractedTask, type TaskAttemptResult } from "../../src/subagent/task-revision-loop";

const contract: SubagentContract = {
	role: "completion-worker",
	scope: { include: ["done.txt"], exclude: [] },
	successCriteria: [
		{
			id: "changed-done",
			description: "done.txt must be changed",
			check: { type: "scope-include", globs: ["done.txt"] },
		},
	],
	escalation: { onUncertainty: "ask-parent" as const, budgetCap: 1000 },
};

describe("contracted task completion seam", () => {
	it("treats missing structured completion as verifier failure even when files changed", async () => {
		const attempts: string[] = [];
		const result = await executeContractedTask({
			contract,
			baseAssignment: "write done.txt",
			maxRetries: 0,
			runOnce: async ({ composedAssignment }): Promise<TaskAttemptResult> => {
				attempts.push(composedAssignment);
				return {
					output: "plain success text",
					exitCode: 0,
					aborted: false,
					changedFiles: ["done.txt"],
					cwd: process.cwd(),
					completion: { hasYield: false, verified: false },
				};
			},
		});

		expect(attempts).toHaveLength(1);
		expect(result.finalVerdict.verdict).toBe("fail");
		expect(result.attempts[0]?.result.changedFiles).toEqual([]);
	});

	it("keeps existing successful path when structured completion is verified", async () => {
		const result = await executeContractedTask({
			contract,
			baseAssignment: "write done.txt",
			maxRetries: 0,
			runOnce: async (): Promise<TaskAttemptResult> => ({
				output: JSON.stringify({ changedFiles: ["done.txt"] }),
				exitCode: 0,
				aborted: false,
				changedFiles: ["done.txt"],
				cwd: process.cwd(),
				completion: { hasYield: true, verified: true },
			}),
		});

		expect(result.finalVerdict.verdict).toBe("pass");
		expect(result.attempts[0]?.result.changedFiles).toEqual(["done.txt"]);
	});

	it("adds bounded critic action requests to retry prompts", async () => {
		const assignments: string[] = [];
		const result = await executeContractedTask({
			contract,
			baseAssignment: "write done.txt",
			maxRetries: 1,
			criticActions: [
				{
					id: "critic-source-proof",
					description: "Structured critic requires source proof before completion.",
					requiredAction: "collect-evidence",
					severity: "blocking",
				},
			],
			runOnce: async ({ composedAssignment }): Promise<TaskAttemptResult> => {
				assignments.push(composedAssignment);
				return {
					output: "attempt",
					exitCode: 0,
					aborted: false,
					changedFiles: assignments.length === 1 ? [] : ["done.txt"],
					cwd: process.cwd(),
					completion: { hasYield: true, verified: true },
				};
			},
		});

		expect(result.finalVerdict.verdict).toBe("pass");
		expect(assignments).toHaveLength(2);
		expect(assignments[1]).toContain("critic-source-proof");
		expect(assignments[1]).toContain("Required action: collect-evidence.");
	});
});
