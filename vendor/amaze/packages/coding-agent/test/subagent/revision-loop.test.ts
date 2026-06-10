/**
 * V3 T4-G — auto revision-loop primitive proof.
 *
 * Verifies that `runRevisionLoop` correctly drives the subagent retry contract:
 *   1. First attempt passes → no retry, returns pass verdict immediately.
 *   2. First attempt fails → retry receives a structured RevisionRequest naming the
 *      failed criteria + their evidence (not a vague "try again").
 *   3. Retry succeeds → returns pass.
 *   4. Both attempts fail → returns last fail verdict, parent sees attempt history.
 *   5. maxRetries=0 (disabled) → no retry, single-pass behavior.
 *
 * The primitive is production-ready; the task tool's integration to actually invoke
 * `runRevisionLoop` in place of single-shot subagent execution lives in a follow-up
 * cycle (touches task/index.ts's result aggregation pipeline).
 */

import { describe, expect, it } from "bun:test";
import {
	type RevisionRequest,
	renderRevisionRequest,
	runRevisionLoop,
	type SubagentCompletion,
	type SubagentContract,
} from "@amaze/coding-agent/subagent/contract";

const baseContract = (overrides: Partial<SubagentContract> = {}): SubagentContract => ({
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
	...overrides,
});

describe("runRevisionLoop", () => {
	it("passes on first attempt → no retry triggered", async () => {
		let calls = 0;
		const result = await runRevisionLoop({
			contract: baseContract(),
			attempt: async revisionRequest => {
				calls++;
				expect(revisionRequest).toBeUndefined();
				return { role: "r", cwd: "/tmp", changedFiles: ["src/x.ts"] } satisfies SubagentCompletion;
			},
		});
		expect(calls).toBe(1);
		expect(result.finalVerdict.verdict).toBe("pass");
		expect(result.attempts).toHaveLength(1);
	});

	it("retries with structured failure list when first attempt fails", async () => {
		let calls = 0;
		let observedRevision: RevisionRequest | undefined;
		const result = await runRevisionLoop({
			contract: baseContract(),
			attempt: async revisionRequest => {
				calls++;
				observedRevision = revisionRequest;
				// First attempt leaks outside scope → fails.
				if (calls === 1) {
					return { role: "r", cwd: "/tmp", changedFiles: ["src/x.ts", "docs/leak.md"] };
				}
				// Retry corrects the leak → passes.
				return { role: "r", cwd: "/tmp", changedFiles: ["src/x.ts", "src/y.ts"] };
			},
		});
		expect(calls).toBe(2);
		expect(result.finalVerdict.verdict).toBe("pass");
		expect(result.attempts).toHaveLength(2);
		// Retry MUST have received the structured failure list from attempt 1.
		expect(observedRevision).toBeDefined();
		expect(observedRevision?.failedCriteria).toHaveLength(1);
		expect(observedRevision?.failedCriteria[0].id).toBe("scope-clean");
		expect(observedRevision?.failedCriteria[0].evidence).toContain("docs/leak.md");
	});

	it("returns the last failed verdict when retry also fails (cap respected)", async () => {
		const result = await runRevisionLoop({
			contract: baseContract(),
			attempt: async () => ({ role: "r", cwd: "/tmp", changedFiles: ["src/x.ts", "docs/leak.md"] }),
		});
		expect(result.finalVerdict.verdict).toBe("fail");
		expect(result.attempts).toHaveLength(2); // initial + 1 retry
	});

	it("maxRetries=0 disables retry entirely (single-shot mode)", async () => {
		let calls = 0;
		const result = await runRevisionLoop({
			contract: baseContract(),
			attempt: async () => {
				calls++;
				return { role: "r", cwd: "/tmp", changedFiles: ["docs/leak.md"] };
			},
			maxRetries: 0,
		});
		expect(calls).toBe(1);
		expect(result.finalVerdict.verdict).toBe("fail");
		expect(result.attempts).toHaveLength(1);
	});

	it("does not retry uncertain-only verifier results", async () => {
		let calls = 0;
		const result = await runRevisionLoop({
			contract: baseContract({
				successCriteria: [
					{
						id: "manual",
						description: "manual operator judgment",
						check: { type: "manual", description: "judge externally" },
						blocking: "fail-only",
					},
				],
			}),
			attempt: async () => {
				calls++;
				return { role: "r", cwd: "/tmp", changedFiles: [] };
			},
		});

		expect(calls).toBe(1);
		expect(result.finalVerdict.verdict).toBe("pass");
		expect(result.finalVerdict.uncertainCount).toBe(1);
	});

	it("PHASE-T4-G ACCEPTANCE: revision request carries criterion id, description, and evidence", async () => {
		let observedRevision: RevisionRequest | undefined;
		await runRevisionLoop({
			contract: baseContract({
				successCriteria: [
					{
						id: "C1",
						description: "deliver report.md",
						check: { type: "file-exists", path: "/nonexistent/report.md" },
					},
				],
			}),
			attempt: async revisionRequest => {
				if (revisionRequest) observedRevision = revisionRequest;
				return { role: "r", cwd: "/tmp", changedFiles: [] };
			},
		});
		expect(observedRevision).toBeDefined();
		const req = observedRevision!;
		expect(req.attemptNumber).toBe(1);
		expect(req.failedCriteria[0]).toEqual({
			id: "C1",
			description: "deliver report.md",
			evidence: expect.stringContaining("File missing"),
		});
	});
});

describe("renderRevisionRequest", () => {
	it("renders an actionable prompt fragment for the retry attempt", () => {
		const rendered = renderRevisionRequest({
			attemptNumber: 1,
			failedCriteria: [
				{ id: "tests-pass", description: "all tests green", evidence: "Exit code 1; 2 failures" },
				{ id: "no-warnings", description: "lint clean", evidence: "found 3 warnings" },
			],
		});
		expect(rendered).toContain("Revision request (attempt 2)");
		expect(rendered).toContain("**[tests-pass]** all tests green");
		expect(rendered).toContain("Evidence: Exit code 1; 2 failures");
		expect(rendered).toContain("**[no-warnings]** lint clean");
		expect(rendered).toContain("iterate on what you already produced");
	});
});
