import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateProposal, runSandboxReplay } from "../../src/learning/eval";
import type { LearningProposal } from "../../src/learning/types";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

describe("sandbox replay eval gate", () => {
	test("settings proposal passes when regression command exits successfully", async () => {
		const workspaceRoot = await createTempDir();
		const report = await runSandboxReplay(settingsProposal({ regressionCommands: [{ argv: ["true"] }] }), {
			workspaceRoot,
		});

		expect(report.ok).toBe(true);
		expect(report.perCommand).toHaveLength(1);
		expect(report.perCommand[0]).toMatchObject({ argv: ["true"], exit: 0, timedOut: false });
		expect(report.revertedCleanly).toBe(true);
	});

	test("settings proposal failure makes pipeline verdict fail", async () => {
		const workspaceRoot = await createTempDir();
		const report = await evaluateProposal(settingsProposal({ regressionCommands: [{ argv: ["false"] }] }), {
			workspaceRoot,
		});

		expect(report.passed).toBe(false);
		expect(report.stage).toBe("done");
		expect(report.patchHash).toMatch(/^[a-f0-9]{64}$/);
		expect(report.sandbox?.ok).toBe(false);
		expect(report.sandbox?.perCommand[0]).toMatchObject({ argv: ["false"], exit: 1, timedOut: false });
	});

	test("timeout marks command timedOut and fails sandbox", async () => {
		const workspaceRoot = await createTempDir();
		const report = await runSandboxReplay(
			settingsProposal({ regressionCommands: [{ argv: ["sleep", "5"], timeoutMs: 100 }] }),
			{ workspaceRoot },
		);

		expect(report.ok).toBe(false);
		expect(report.perCommand[0]?.timedOut).toBe(true);
		expect(report.perCommand[0]?.exit).toBeNull();
		expect(report.revertedCleanly).toBe(true);
	});

	test("temporary sandbox is removed when command spawn throws", async () => {
		const workspaceRoot = await createTempDir();
		const tmpRoot = await createTempDir({ keepForAssertion: true });

		await expect(
			runSandboxReplay(settingsProposal({ regressionCommands: [{ argv: [] }] }), { workspaceRoot, tmpRoot }),
		).rejects.toThrow();
		expect(await fs.readdir(tmpRoot)).toEqual([]);
	});
});

async function createTempDir(opts: { keepForAssertion?: boolean } = {}): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-replay-test-"));
	if (!opts.keepForAssertion) {
		cleanups.push(async () => {
			await fs.rm(dir, { recursive: true, force: true });
		});
	}
	return dir;
}

function settingsProposal(overrides: Partial<LearningProposal> = {}): LearningProposal {
	return {
		id: "proposal-1",
		createdAt: 1,
		status: "approved",
		gate: "auto",
		evidence: { sessionIds: ["session-1"], eventRefs: ["events.jsonl:1"], sampleN: 1 },
		provenance: { source: "manual" },
		type: "settings",
		patch: { model: "test" },
		reason: "Exercise sandbox replay.",
		rollback: {},
		...overrides,
	} as LearningProposal;
}
