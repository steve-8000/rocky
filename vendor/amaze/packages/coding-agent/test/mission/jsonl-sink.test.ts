import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionEventBus } from "../../src/mission/event-bus";
import type { MissionEvent } from "../../src/mission/events";
import { MissionJsonlSink } from "../../src/mission/jsonl-sink";
import { readMissionEvents } from "../../src/mission/reader";

const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-jsonl-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("MissionJsonlSink", () => {
	test("writes separate mission files and flushes multiple event types", async () => {
		const baseDir = tempRoot();
		const bus = new MissionEventBus();
		const sink = new MissionJsonlSink(bus, { baseDir, batchSize: 10, flushIntervalMs: 10_000 });
		const first: MissionEvent = {
			type: "research.brief.created",
			missionId: "mission-1",
			briefId: "brief-1",
			objectiveId: "objective-1",
			lanes: ["repo", "source"],
			ts: 1,
		};
		const second: MissionEvent = {
			type: "research.evidence.added",
			missionId: "mission-1",
			briefId: "brief-1",
			evidenceId: "ev-1",
			lane: "repo",
			grade: "A",
			ts: 2,
		};
		const third: MissionEvent = {
			type: "decision.recorded",
			missionId: "mission-2",
			briefId: "brief-2",
			decisionId: "dec-1",
			confidence: "high",
			ts: 3,
		};

		bus.emit(first);
		bus.emit(second);
		bus.emit(third);
		await new Promise(resolve => queueMicrotask(resolve));
		await sink.flush();
		await sink.close();

		const mission1 = fs
			.readFileSync(path.join(baseDir, "mission-1.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const mission2 = fs
			.readFileSync(path.join(baseDir, "mission-2.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));

		expect(mission1).toEqual([first, second]);
		expect(mission2).toEqual([third]);
	});

	test("rolls mission files by byte size and remains reader-compatible", async () => {
		const baseDir = tempRoot();
		const bus = new MissionEventBus();
		const sink = new MissionJsonlSink(bus, { baseDir, batchSize: 10, flushIntervalMs: 10_000, maxBytes: 120 });
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
				type: "rollback.snapshot.created",
				missionId: "mission-roll",
				rollbackId: "rollback-1",
				targetType: "decision",
				targetId: "decision-1",
				snapshotRef: "snapshot-1",
				ts: 3,
			},
		];

		for (const event of events) bus.emit(event);
		await new Promise(resolve => queueMicrotask(resolve));
		await sink.flush();
		await sink.close();

		expect(fs.existsSync(path.join(baseDir, "mission-roll.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(baseDir, "mission-roll.1.jsonl"))).toBe(true);
		expect(await readMissionEvents("mission-roll", { baseDir })).toEqual(events);
	});
});
