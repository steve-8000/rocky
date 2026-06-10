import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaySession } from "../../src/learning/eval";
import type { SessionEvent } from "../../src/observability";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("replaySession", () => {
	test("replays synthetic JSONL without network calls and captures goal verdict", async () => {
		const baseDir = await mkTempDir();
		const sessionId = "session-1";
		const events: SessionEvent[] = [
			{ type: "session.start", sessionId, ts: 1, cwd: "/tmp/project", agent: "test" },
			{ type: "goal.start", sessionId, ts: 2, goalId: "goal-1", title: "Ship", criteriaCount: 1 },
			{
				type: "subagent.end",
				sessionId,
				ts: 3,
				taskId: "task-1",
				verdict: "pass",
				changedFiles: 1,
				revisions: 1,
			},
			{
				type: "goal.complete",
				sessionId,
				ts: 4,
				goalId: "goal-1",
				verdict: "pass",
				failedCount: 0,
				uncertainCount: 0,
			},
		];
		await writeFile(
			path.join(baseDir, `${sessionId}.jsonl`),
			`${events.map(event => JSON.stringify(event)).join("\n")}\n`,
		);

		const report = await replaySession(sessionId, { baseDir });

		expect(report.networkCalls).toBe(0);
		expect(report.eventsReplayed).toBe(events.length);
		expect(report.decisions.goalCompleteVerdict).toBe("pass");
		expect(report.decisions.subagentVerdicts).toEqual([{ taskId: "task-1", verdict: "pass" }]);
	});

	test("uses supplied events and records memory patch without changing decisions", async () => {
		const sessionId = "session-2";
		const events: SessionEvent[] = [
			{
				type: "goal.complete",
				sessionId,
				ts: 1,
				goalId: "goal-2",
				verdict: "force",
				failedCount: 1,
				uncertainCount: 0,
			},
		];

		const report = await replaySession(sessionId, {
			baseDir: "/does/not/matter",
			events,
			memoryPatch: { adds: ["new memory"], removes: ["old memory"] },
		});

		expect(report.networkCalls).toBe(0);
		expect(report.eventsReplayed).toBe(1);
		expect(report.decisions.goalCompleteVerdict).toBe("force");
		expect(report.metadata?.memoryPatch).toEqual({ adds: ["new memory"], removes: ["old memory"] });
	});
});

async function mkTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "amaze-replay-test-"));
	const normalized = dir.trim();
	dirs.push(normalized);
	return normalized;
}
