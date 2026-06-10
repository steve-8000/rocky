import { afterEach, describe, expect, test } from "bun:test";
import { MissionEventBus } from "../../src/mission/event-bus";
import { MissionStore } from "../../src/mission/store";
import type { NewResearchCampaign } from "../../src/mission/types";

const stores: MissionStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0).reverse()) store.close();
});

function createStore(): MissionStore {
	const store = new MissionStore(":memory:");
	stores.push(store);
	return store;
}

function mission(overrides: Partial<NewResearchCampaign> = {}): NewResearchCampaign {
	return {
		title: "Mission contracts",
		objectiveId: "objective-1",
		briefId: null,
		decisionId: null,
		riskLevel: "medium",
		state: "contracted",
		confidence: null,
		snapshotRef: null,
		...overrides,
	};
}

describe("MissionStore contract persistence", () => {
	test("round-trips contract arrays and JSON fields", () => {
		const store = createStore();
		const createdMission = store.createMission(mission({ id: "mission-contract" }));

		const contract = store.recordContract({
			id: "contract-1",
			missionId: createdMission.id,
			role: "wave5-contracts",
			parentMissionRev: 3,
			include: ["packages/coding-agent/src/mission/types.ts", "packages/coding-agent/src/mission/store.ts"],
			exclude: ["docs/**"],
			successCriteria: ["checkts", "wave5tests"],
			escalation: { onUncertainty: "block", budgetCap: 1200000 },
			inputArtifact: "local://contract.md",
			mustProduce: ["changed files", "verification results"],
			taskId: "task-contract",
			sessionFile: "/tmp/task-contract.jsonl",
			createdAt: 10,
		});

		expect(store.listContracts(createdMission.id)).toEqual([contract]);
	});

	test("selects latest verification by createdAt then id", () => {
		const store = createStore();
		const createdMission = store.createMission(mission({ id: "mission-verification" }));
		store.recordVerification({
			id: "verification-a",
			missionId: createdMission.id,
			status: "fail",
			failedCount: 1,
			uncertainCount: 0,
			summary: "old failure",
			createdAt: 10,
		});
		const latest = store.recordVerification({
			id: "verification-b",
			missionId: createdMission.id,
			status: "pass",
			failedCount: 0,
			uncertainCount: 0,
			summary: "latest pass",
			createdAt: 20,
		});

		expect(store.getLatestVerification(createdMission.id)).toEqual(latest);
	});

	test("round-trips rollback records", () => {
		const store = createStore();
		const createdMission = store.createMission(mission({ id: "mission-rollback" }));

		const first = store.recordRollback({
			id: "rollback-1",
			missionId: createdMission.id,
			targetType: "decision",
			targetId: "decision-1",
			snapshotRef: "snapshot-1",
			summary: "restore decision snapshot",
			createdAt: 10,
		});
		const second = store.recordRollback({
			id: "rollback-2",
			missionId: createdMission.id,
			targetType: "file",
			targetId: "src/file.ts",
			snapshotRef: null,
			summary: "restore file contents",
			createdAt: 20,
		});

		expect(store.listRollbacks(createdMission.id)).toEqual([first, second]);
	});

	test("finds latest missions by objective, brief, and exact title", () => {
		const store = createStore();
		const first = store.createMission(
			mission({ id: "mission-first", title: "Shared", objectiveId: "objective-x", briefId: "brief-x" }),
		);
		const second = store.createMission(
			mission({ id: "mission-second", title: "Shared", objectiveId: "objective-x", briefId: "brief-x" }),
		);
		store.createMission(
			mission({ id: "mission-other", title: "Other", objectiveId: "objective-y", briefId: "brief-y" }),
		);

		expect(store.findLatestMissionByObjectiveId("objective-x")?.id).toBe(second.id);
		expect(store.findLatestMissionByBriefId("brief-x")?.id).toBe(second.id);
		expect(store.findLatestMissionByTitle("Shared")?.id).toBe(second.id);
		expect(store.findLatestMissionByTitle("Missing")).toBeUndefined();
		expect(first.id).toBe("mission-first");
	});

	test("emits contract verification and rollback events", () => {
		const bus = new MissionEventBus();
		const store = new MissionStore(":memory:", bus);
		stores.push(store);
		const createdMission = store.createMission(mission({ id: "mission-events" }));

		const contract = store.recordContract({
			id: "contract-event",
			missionId: createdMission.id,
			role: "producer",
			parentMissionRev: null,
			include: ["src/**"],
			exclude: [],
			successCriteria: ["check"],
			escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
			inputArtifact: null,
			mustProduce: ["notes"],
			createdAt: 30,
		});
		const verification = store.recordVerification({
			id: "verification-event",
			missionId: createdMission.id,
			status: "pass",
			failedCount: 0,
			uncertainCount: 0,
			summary: "ok",
			createdAt: 40,
		});
		const rollback = store.recordRollback({
			id: "rollback-event",
			missionId: createdMission.id,
			targetType: "proposal",
			targetId: "proposal-1",
			snapshotRef: "snapshot-1",
			summary: "applied",
			createdAt: 50,
		});

		expect(bus.snapshot()).toEqual([
			{ type: "contract.created", missionId: createdMission.id, contractId: contract.id, role: "producer", ts: 30 },
			{
				type: "verification.completed",
				missionId: createdMission.id,
				verificationId: verification.id,
				status: "pass",
				failedCount: 0,
				uncertainCount: 0,
				ts: 40,
			},
			{
				type: "rollback.snapshot.created",
				missionId: createdMission.id,
				rollbackId: rollback.id,
				targetType: "proposal",
				targetId: "proposal-1",
				snapshotRef: "snapshot-1",
				ts: 50,
			},
		]);
	});
});
