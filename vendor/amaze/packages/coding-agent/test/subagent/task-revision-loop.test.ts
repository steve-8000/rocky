/**
 * V3 T4-G integration — executeContractedTask proof.
 *
 * Tests the orchestration helper that the task tool calls when a task carries a
 * SubagentContract. Mocks the runOnce executor callback so we can script multi-attempt
 * sequences without spinning up real subagent sessions.
 *
 * Coverage:
 *   - First attempt passes → 1 invocation, no revision request, verdict surfaces
 *   - First fails / retry passes → 2 invocations, retry receives RevisionRequest composed
 *     into the assignment text
 *   - Both fail → returns last failed verdict + history of both attempts
 *   - maxRetries=0 → single-pass, no retry even on fail
 *   - Assignment composition: retry assignment starts with `# Revision request` block
 */

import { describe, expect, it } from "bun:test";
import type { SubagentContract } from "@amaze/coding-agent/subagent/contract";
import { executeContractedTask, type TaskAttemptResult } from "@amaze/coding-agent/subagent/task-revision-loop";

const baseContract = (): SubagentContract => ({
	role: "refactor-applier",
	scope: { include: ["src/**"], exclude: [] },
	successCriteria: [
		{
			id: "scope-clean",
			description: "edits stay inside src/",
			check: { type: "scope-include", globs: ["src/**"] },
		},
	],
	escalation: { onUncertainty: "ask-parent", budgetCap: 25000 },
});

const cleanResult = (overrides: Partial<TaskAttemptResult> = {}): TaskAttemptResult => ({
	output: "done",
	exitCode: 0,
	aborted: false,
	changedFiles: ["src/x.ts"],
	cwd: "/tmp/amaze",
	...overrides,
});

const leakyResult = (overrides: Partial<TaskAttemptResult> = {}): TaskAttemptResult => ({
	output: "done",
	exitCode: 0,
	aborted: false,
	changedFiles: ["src/x.ts", "docs/leak.md"],
	cwd: "/tmp/amaze",
	...overrides,
});

describe("executeContractedTask", () => {
	it("single attempt path: clean first attempt returns pass, no retry triggered", async () => {
		let runCalls = 0;
		const outcome = await executeContractedTask({
			contract: baseContract(),
			baseAssignment: "do the refactor",
			runOnce: async ({ revisionRequest, composedAssignment }) => {
				runCalls++;
				expect(revisionRequest).toBeUndefined();
				// Initial attempt sees the base assignment as-is (no revision block prepended).
				expect(composedAssignment).toBe("do the refactor");
				return cleanResult();
			},
		});

		expect(runCalls).toBe(1);
		expect(outcome.finalVerdict.verdict).toBe("pass");
		expect(outcome.attempts).toHaveLength(1);
	});

	it("retry path: first attempt leaks scope, retry corrects, final verdict pass", async () => {
		let runCalls = 0;
		let observedRetryAssignment: string | undefined;

		const outcome = await executeContractedTask({
			contract: baseContract(),
			baseAssignment: "do the refactor",
			runOnce: async ({ revisionRequest, composedAssignment }) => {
				runCalls++;
				if (runCalls === 1) {
					expect(revisionRequest).toBeUndefined();
					return leakyResult(); // first attempt out of scope
				}
				// Retry sees structured revision request prepended to assignment.
				observedRetryAssignment = composedAssignment;
				return cleanResult(); // clean second attempt
			},
		});

		expect(runCalls).toBe(2);
		expect(outcome.finalVerdict.verdict).toBe("pass");
		expect(outcome.attempts).toHaveLength(2);
		expect(outcome.attempts[0].verdict.verdict).toBe("fail");
		expect(outcome.attempts[1].verdict.verdict).toBe("pass");

		// PHASE-T4-G-INT ACCEPTANCE: the retry assignment composes the structured revision
		// block ahead of the original assignment. Subagent sees what failed AND the original task.
		expect(observedRetryAssignment).toContain("# Revision request");
		expect(observedRetryAssignment).toContain("scope-clean");
		expect(observedRetryAssignment).toContain("docs/leak.md"); // evidence carried through
		expect(observedRetryAssignment).toContain("---");
		expect(observedRetryAssignment).toContain("do the refactor"); // base assignment preserved
	});

	it("both attempts fail: returns last fail verdict + 2-attempt history", async () => {
		let runCalls = 0;
		const outcome = await executeContractedTask({
			contract: baseContract(),
			baseAssignment: "do the refactor",
			runOnce: async () => {
				runCalls++;
				return leakyResult();
			},
		});

		expect(runCalls).toBe(2); // initial + 1 retry (default maxRetries)
		expect(outcome.finalVerdict.verdict).toBe("fail");
		expect(outcome.attempts).toHaveLength(2);
		// Final result reflects the LAST attempt so the parent can surface its output.
		expect(outcome.finalResult.changedFiles).toContain("docs/leak.md");
	});

	it("maxRetries=0 disables retry (single-pass mode for ad-hoc contracted tasks)", async () => {
		let runCalls = 0;
		const outcome = await executeContractedTask({
			contract: baseContract(),
			baseAssignment: "do it",
			maxRetries: 0,
			runOnce: async () => {
				runCalls++;
				return leakyResult();
			},
		});
		expect(runCalls).toBe(1);
		expect(outcome.finalVerdict.verdict).toBe("fail");
	});

	it("changedFiles+cwd from result are passed to verifier (real verification, not mock)", async () => {
		// Use file-exists criterion that depends on real cwd — proves the loop threads
		// the result's cwd through to the verifier context, not a hardcoded one.
		const contract: SubagentContract = {
			role: "test-writer",
			scope: { include: [], exclude: [] },
			successCriteria: [
				{
					id: "produced",
					description: "result file exists",
					check: { type: "file-exists", path: "/this/path/should/not/exist" },
				},
			],
			escalation: { onUncertainty: "block", budgetCap: 1000 },
		};

		const outcome = await executeContractedTask({
			contract,
			baseAssignment: "make the file",
			runOnce: async () => cleanResult({ cwd: "/tmp/whatever" }),
		});

		expect(outcome.finalVerdict.verdict).toBe("fail");
		const evidence = outcome.finalVerdict.results[0].evidence;
		expect(evidence).toContain("/this/path/should/not/exist");
		expect(evidence).toContain("missing");
	});
});
