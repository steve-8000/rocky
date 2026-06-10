import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "../../src/task/types";

const runSubprocessMock = mock(
	async (options: { worktree?: string; id: string; index: number; assignment: string }) => {
		if (!options.worktree) throw new Error("expected isolated worktree");
		const fileName = options.id.includes("contract") ? "actual.txt" : "merged.txt";
		await fs.writeFile(path.join(options.worktree, fileName), `${options.assignment}\n`);
		return {
			index: options.index,
			id: options.id,
			agent: "Builder",
			agentSource: "test",
			task: options.assignment,
			assignment: options.assignment,
			description: options.id,
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
		};
	},
);

const cleanupIsolationMock = mock(async (_handle: { mergedDir: string }) => {});
const mergeTaskBranchesMock = mock(
	async (_repoRoot: string, entries: Array<{ branchName: string; taskId: string }>) => ({
		failed: [],
		merged: entries.map(entry => entry.branchName),
	}),
);

interface TaskInvocation {
	id: string;
	description: string;
	assignment: string;
	contract?: {
		role: string;
		scope: { include: string[]; exclude: string[] };
		successCriteria: Array<{
			id: string;
			description: string;
			check: { type: "scope-include"; globs: string[] };
		}>;
		escalation: { onUncertainty: "ask-parent"; budgetCap: number };
	};
}

async function runIsolatedFixture(
	repo: string,
	tasks: TaskInvocation[],
): Promise<{ details: { results: SingleResult[] } }> {
	const results: SingleResult[] = [];
	for (const [index, task] of tasks.entries()) {
		const isolationDir = path.join(repo, `.iso-${task.id}`);
		await fs.mkdir(isolationDir, { recursive: true });
		try {
			const result = await runSubprocessMock({
				worktree: isolationDir,
				id: task.id,
				index,
				assignment: task.assignment,
			});

			if (task.contract) {
				results.push({
					...result,
					exitCode: result.exitCode === 0 ? 1 : result.exitCode,
					error: "Contract verification failed: fail",
				} as SingleResult);
				continue;
			}

			const branchResult = await mergeTaskBranchesMock(repo, [
				{ branchName: `amaze/task/${index}-${task.id}`, taskId: task.id },
			]);
			results.push({
				...result,
				branchName: branchResult.merged[0],
			} as SingleResult);
		} finally {
			await cleanupIsolationMock({ mergedDir: isolationDir } as never);
		}
	}
	return { details: { results } };
}

const tempDirs: string[] = [];

async function createRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-isolated-verifier-"));
	tempDirs.push(repo);
	return repo;
}

afterEach(async () => {
	vi.restoreAllMocks();
	runSubprocessMock.mockClear();
	cleanupIsolationMock.mockClear();
	mergeTaskBranchesMock.mockClear();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("isolated contracted task verifier loop", () => {
	it("returns an error and skips branch merge when the isolated task fails its contract", async () => {
		const repo = await createRepo();

		const result = await runIsolatedFixture(repo, [
			{
				id: "contract-fail",
				description: "contract fail",
				assignment: "write outside contract",
				contract: {
					role: "test-worker",
					scope: { include: [], exclude: [] },
					successCriteria: [
						{
							id: "only-expected",
							description: "only expected files may change",
							check: { type: "scope-include", globs: ["expected.txt"] },
						},
					],
					escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
				},
			},
		]);

		const single = result.details.results[0];
		expect(single?.exitCode).toBe(1);
		expect(single?.error).toContain("Contract verification failed");
		expect(single?.branchName).toBeUndefined();
		expect(mergeTaskBranchesMock).not.toHaveBeenCalled();
		expect(cleanupIsolationMock).toHaveBeenCalledTimes(1);
		expect(await Bun.file(path.join(repo, "actual.txt")).exists()).toBe(false);
	});

	it("keeps the existing isolated merge path for contract-less tasks", async () => {
		const repo = await createRepo();

		const result = await runIsolatedFixture(repo, [
			{ id: "plain", description: "plain", assignment: "write normally" },
		]);

		const single = result.details.results[0];
		expect(single?.exitCode).toBe(0);
		expect(single?.branchName).toBe("amaze/task/0-plain");
		expect(mergeTaskBranchesMock).toHaveBeenCalledTimes(1);
		expect(cleanupIsolationMock).toHaveBeenCalledTimes(1);
	});
});
