import { describe, expect, test } from "bun:test";
import { MissionStore } from "../../src/mission/store";
import type { NewResearchCampaign } from "../../src/mission/types";

function mission(overrides: Partial<NewResearchCampaign> = {}): NewResearchCampaign {
	return {
		title: "Checkpoint mission",
		objectiveId: "objective-checkpoint",
		briefId: null,
		decisionId: null,
		riskLevel: "medium",
		state: "executing",
		confidence: null,
		snapshotRef: null,
		...overrides,
	};
}

describe("MissionStore task attempt checkpoints", () => {
	test("round-trips durable delegated-work failure checkpoint state", () => {
		const store = new MissionStore(":memory:");
		const createdMission = store.createMission(mission({ id: "mission-checkpoint" }));

		const checkpoint = store.recordTaskAttemptCheckpoint({
			id: "checkpoint-1",
			missionId: createdMission.id,
			taskId: "task-1",
			agent: "Builder",
			role: "implementer",
			attempt: 2,
			status: "failed",
			failureMode: "contract-fail",
			lastVerdict: "fail",
			failedCount: 1,
			uncertainCount: 0,
			remediationAction: "escalate",
			sessionFile: "/tmp/task.jsonl",
			artifactRefs: ["agent://task-1", "artifact://patch"],
			error: "Contract verification failed: fail",
			createdAt: 10,
			updatedAt: 11,
		});

		expect(store.listTaskAttemptCheckpoints(createdMission.id)).toEqual([checkpoint]);
		expect(store.getLatestTaskAttemptCheckpoint(createdMission.id, "task-1")).toEqual(checkpoint);
	});
});
