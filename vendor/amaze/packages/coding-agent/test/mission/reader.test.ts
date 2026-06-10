import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MissionEvent } from "../../src/mission/events";
import { readMissionEvents } from "../../src/mission/reader";

const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-reader-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("readMissionEvents", () => {
	test("returns an empty array for a missing mission file", async () => {
		const baseDir = tempRoot();
		expect(await readMissionEvents("missing", { baseDir })).toEqual([]);
	});

	test("parses JSONL in file order", async () => {
		const baseDir = tempRoot();
		fs.mkdirSync(baseDir, { recursive: true });
		const events: MissionEvent[] = [
			{
				type: "research.lane.started",
				missionId: "mission-1",
				laneRunId: "lane-1",
				lane: "repo",
				agent: "Explore",
				epistemicRole: "repo_truth",
				ts: 10,
			},
			{
				type: "research.lane.completed",
				missionId: "mission-1",
				laneRunId: "lane-1",
				lane: "repo",
				status: "completed",
				evidenceCount: 2,
				emptyReason: null,
				ts: 20,
			},
		];
		fs.writeFileSync(
			path.join(baseDir, "mission-1.jsonl"),
			`${events.map(event => JSON.stringify(event)).join("\n")}\n`,
		);

		expect(await readMissionEvents("mission-1", { baseDir })).toEqual(events);
	});

	test("reads rollover segments in numeric order", async () => {
		const baseDir = tempRoot();
		fs.mkdirSync(baseDir, { recursive: true });
		const events: MissionEvent[] = [
			{
				type: "decision.recorded",
				missionId: "mission-roll",
				briefId: "brief-1",
				decisionId: "decision-1",
				confidence: "high",
				ts: 1,
			},
			{
				type: "contract.created",
				missionId: "mission-roll",
				contractId: "contract-1",
				role: "worker",
				ts: 2,
			},
			{
				type: "verification.completed",
				missionId: "mission-roll",
				verificationId: "verification-1",
				status: "pass",
				failedCount: 0,
				uncertainCount: 0,
				ts: 3,
			},
		];
		fs.writeFileSync(path.join(baseDir, "mission-roll.2.jsonl"), `${JSON.stringify(events[2])}\n`);
		fs.writeFileSync(path.join(baseDir, "mission-roll.jsonl"), `${JSON.stringify(events[0])}\n`);
		fs.writeFileSync(path.join(baseDir, "mission-roll.1.jsonl"), `${JSON.stringify(events[1])}\n`);
		fs.writeFileSync(path.join(baseDir, "mission-roll.ignore.jsonl"), "{}\n");

		expect(await readMissionEvents("mission-roll", { baseDir })).toEqual(events);
	});
});
