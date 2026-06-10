import { describe, expect, it } from "bun:test";
import type { SubagentContract } from "../../src/subagent/contract";
import { executeContractedTask, type TaskAttemptResult } from "../../src/subagent/task-revision-loop";

const contract: SubagentContract = {
	role: "verdict-worker",
	scope: { include: ["expected.txt"], exclude: [] },
	successCriteria: [
		{
			id: "only-expected",
			description: "only expected.txt may change",
			check: { type: "scope-include", globs: ["expected.txt"] },
		},
	],
	escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
};

async function runContractPath(cwd: string): Promise<string> {
	const outcome = await executeContractedTask({
		contract,
		baseAssignment: "write actual.txt",
		maxRetries: 0,
		runOnce: async (): Promise<TaskAttemptResult> => ({
			output: "ok",
			exitCode: 0,
			aborted: false,
			changedFiles: ["actual.txt"],
			cwd,
			completion: { hasYield: true, verified: true },
		}),
	});
	return outcome.finalVerdict.verdict;
}

describe("contract verdict semantics", () => {
	it("reports equivalent verifier verdicts for isolated and non-isolated task attempts", async () => {
		const nonIsolatedVerdict = await runContractPath(process.cwd());
		const isolatedVerdict = await runContractPath(process.cwd());

		expect(nonIsolatedVerdict).toBe("fail");
		expect(isolatedVerdict).toBe(nonIsolatedVerdict);
	});

	it("reports equivalent uncertain-blocking verifier results across execution modes", async () => {
		const uncertainContract: SubagentContract = {
			...contract,
			successCriteria: [
				{
					id: "needs-operator",
					description: "requires manual operator judgment",
					check: { type: "llm-judged", question: "is it complete?", candidate: "unknown" },
				},
			],
		};

		const run = async () =>
			executeContractedTask({
				contract: uncertainContract,
				baseAssignment: "operator judgment",
				maxRetries: 0,
				runOnce: async (): Promise<TaskAttemptResult> => ({
					output: "ok",
					exitCode: 0,
					aborted: false,
					changedFiles: [],
					cwd: process.cwd(),
					completion: { hasYield: true, verified: true },
				}),
			});

		const nonIsolatedOutcome = await run();
		const isolatedOutcome = await run();

		expect(nonIsolatedOutcome.finalVerdict.verdict).toBe("fail");
		expect(nonIsolatedOutcome.finalVerdict.uncertainCount).toBe(1);
		expect(isolatedOutcome.finalVerdict).toEqual(nonIsolatedOutcome.finalVerdict);
	});

	it("successful contracted completion does not produce a failure verdict", async () => {
		const outcome = await executeContractedTask({
			contract,
			baseAssignment: "write expected.txt",
			maxRetries: 0,
			runOnce: async (): Promise<TaskAttemptResult> => ({
				output: "ok",
				exitCode: 0,
				aborted: false,
				changedFiles: ["expected.txt"],
				cwd: process.cwd(),
				completion: { hasYield: true, verified: true },
			}),
		});

		expect(outcome.finalVerdict.verdict).toBe("pass");
		expect(outcome.attempts).toHaveLength(1);
	});
});
