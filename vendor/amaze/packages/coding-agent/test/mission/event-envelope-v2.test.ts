import { describe, expect, test } from "bun:test";
import {
	type EventEnvelope,
	isEventEnvelope,
	type MissionCreatedEvent,
	type MissionEvent,
	type MissionLifecycleEvent,
	readEnvelope,
	readMissionEvent,
	toEventEnvelope,
} from "../../src/mission/events";

const lifecycleSamples: MissionLifecycleEvent[] = [
	{ type: "mission.created", missionId: "m1", title: "Build", objectiveId: "o1", riskLevel: "medium", ts: 100 },
	{ type: "mission.classified", missionId: "m1", riskLevel: "high", confidence: "medium", ts: 110 },
	{ type: "mission.planned", missionId: "m1", taskCount: 3, ts: 120 },
	{ type: "mission.task.created", missionId: "m1", taskId: "t1", role: "producer", agent: "exec", ts: 130 },
	{ type: "mission.task.completed", missionId: "m1", taskId: "t1", status: "completed", ts: 140 },
	{
		type: "mission.tool.requested",
		missionId: "m1",
		taskId: "t1",
		toolCallId: "tc1",
		tool: "bash",
		ts: 150,
	},
	{
		type: "mission.tool.completed",
		missionId: "m1",
		taskId: "t1",
		toolCallId: "tc1",
		tool: "bash",
		status: "ok",
		ts: 160,
	},
	{ type: "mission.evidence.added", missionId: "m1", evidenceId: "e1", grade: "A", source: "repo", ts: 170 },
	{ type: "mission.critic.completed", missionId: "m1", blockingCount: 0, softCount: 1, verdict: "pass", ts: 180 },
	{
		type: "mission.verification.completed",
		missionId: "m1",
		verificationId: "v1",
		status: "pass",
		failedCount: 0,
		uncertainCount: 0,
		ts: 190,
	},
	{ type: "mission.completed", missionId: "m1", finalState: "completed", ts: 200 },
	{ type: "mission.blocked", missionId: "m1", reason: "needs approval", ts: 210 },
	{ type: "mission.cancelled", missionId: "m1", reason: null, ts: 220 },
	{
		type: "mission.rolled_back",
		missionId: "m1",
		rollbackId: "r1",
		targetType: "decision",
		targetId: "d1",
		ts: 230,
	},
];

describe("event schema v2 lifecycle events", () => {
	test("every lifecycle event serializes and deserializes round-trip", () => {
		for (const event of lifecycleSamples) {
			const json = JSON.stringify(event);
			const parsed = JSON.parse(json) as MissionEvent;
			expect(parsed).toEqual(event);
			expect(parsed.type).toBe(event.type);
			expect(parsed.missionId).toBe("m1");
		}
	});

	test("lifecycle events round-trip through a v2 envelope", () => {
		for (const event of lifecycleSamples) {
			const envelope = toEventEnvelope(event, { sessionId: "sess-1" });
			const json = JSON.stringify(envelope);
			const parsed = JSON.parse(json) as EventEnvelope;
			expect(isEventEnvelope(parsed)).toBe(true);
			expect(readMissionEvent(parsed)).toEqual(event);
			expect(readEnvelope(parsed).sessionId).toBe("sess-1");
			expect(readEnvelope(parsed).version).toBe(2);
		}
	});
});

describe("dual-read normalization", () => {
	test("legacy v1 flat record (unversioned event) still parses", () => {
		const legacy: MissionCreatedEvent = {
			type: "mission.created",
			missionId: "m9",
			title: "Legacy",
			objectiveId: null,
			riskLevel: "low",
			ts: 42,
		};
		// Simulate an on-disk JSONL line written by the existing flat-event sink.
		const line = JSON.stringify(legacy);
		const record = JSON.parse(line);

		expect(isEventEnvelope(record)).toBe(false);
		const envelope = readEnvelope(record);
		expect(envelope.version).toBe(1);
		expect(envelope.missionId).toBe("m9");
		expect(envelope.timestamp).toBe(42);
		expect(envelope.sessionId).toBeUndefined();
		expect(envelope.event).toEqual(legacy);
		expect(readMissionEvent(record)).toEqual(legacy);
	});

	test("v2 envelope record parses and preserves payload", () => {
		const event: MissionEvent = {
			type: "mission.planned",
			missionId: "m9",
			taskCount: 5,
			ts: 77,
		};
		const envelope = toEventEnvelope(event, { id: "fixed-id", sessionId: "s2" });
		const line = JSON.stringify(envelope);
		const record = JSON.parse(line);

		expect(isEventEnvelope(record)).toBe(true);
		const normalized = readEnvelope(record);
		expect(normalized.id).toBe("fixed-id");
		expect(normalized.version).toBe(2);
		expect(normalized.sessionId).toBe("s2");
		expect(normalized.event).toEqual(event);
	});

	test("readEnvelope throws on a non-event record", () => {
		expect(() => readEnvelope({ foo: "bar" } as never)).toThrow();
	});
});
