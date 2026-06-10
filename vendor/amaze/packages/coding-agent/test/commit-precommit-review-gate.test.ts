import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	getBlockingReviewFindings,
	getReviewableStagedFiles,
	isPreCommitReviewResultPassing,
} from "../src/commit/agentic";
import type { SingleResult } from "../src/task/types";

describe("pre-commit review gate staged file selection", () => {
	it("excludes staged Markdown files from review authority", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-precommit-review-gate-"));
		try {
			await $`git init --initial-branch=main`.cwd(repo).quiet();
			await fs.mkdir(path.join(repo, "src"), { recursive: true });
			await Bun.write(path.join(repo, "src", "review-me.ts"), "export const value = 1;\n");
			await Bun.write(path.join(repo, "README.md"), "# Documentation only\n");
			await $`git add src/review-me.ts README.md`.cwd(repo).quiet();

			const reviewableFiles = await getReviewableStagedFiles(repo);

			expect(reviewableFiles).toEqual(["src/review-me.ts"]);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});
});

describe("pre-commit review gate result evaluation", () => {
	it("fails when the Reviewer verdict is incorrect", () => {
		const result = reviewResult({
			overall_correctness: "incorrect",
			explanation: "The staged patch has a correctness issue.",
			confidence: 0.9,
		});

		expect(isPreCommitReviewResultPassing(result)).toBe(false);
	});

	it("fails on P0/P1 findings in non-Markdown source files", () => {
		const result = reviewResult(
			{
				overall_correctness: "correct",
				explanation: "No blocking issues in the patch.",
				confidence: 0.9,
			},
			[
				{
					title: "Fix broken source behavior",
					body: "This source bug blocks the commit.",
					priority: "P1",
					confidence: 0.95,
					file_path: "src/review-me.ts",
					line_start: 1,
					line_end: 1,
				},
			],
		);

		expect(isPreCommitReviewResultPassing(result)).toBe(false);
		expect(getBlockingReviewFindings(result)).toHaveLength(1);
	});

	it("passes when the verdict is correct and P0/P1 findings only target Markdown", () => {
		const result = reviewResult(
			{
				overall_correctness: "correct",
				explanation: "The staged non-Markdown patch is correct.",
				confidence: 0.9,
			},
			[
				{
					title: "Clarify documentation",
					body: "The Markdown-only issue is not authoritative for this gate.",
					priority: "P0",
					confidence: 0.95,
					file_path: "README.md",
					line_start: 1,
					line_end: 1,
				},
			],
		);

		expect(isPreCommitReviewResultPassing(result)).toBe(true);
		expect(getBlockingReviewFindings(result)).toEqual([]);
	});
});

function reviewResult(summary: ReviewSummary, findings: ReviewFinding[] = []) {
	return {
		index: 0,
		id: "precommit-reviewer",
		agent: "Reviewer",
		agentSource: "bundled",
		task: "review",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		extractedToolData: {
			yield: [{ data: summary }],
			report_finding: findings,
		},
	} satisfies SingleResult;
}

type ReviewSummary = {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
};

type ReviewFinding = {
	title: string;
	body: string;
	priority: "P0" | "P1" | "P2" | "P3";
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
};
