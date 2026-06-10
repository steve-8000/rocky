import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionEventBus } from "../../src/mission/event-bus";
import { MissionStore } from "../../src/mission/store";
import type {
	NewMissionLaneRun,
	NewMissionWorldModelRecord,
	NewResearchCampaign,
	NewResearchRun,
} from "../../src/mission/types";

const stores: MissionStore[] = [];

function createStore(dbPath = ":memory:"): MissionStore {
	const store = new MissionStore(dbPath);
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});

function mission(overrides: Partial<NewResearchCampaign> = {}): NewResearchCampaign {
	return {
		title: "Ship Mission Control",
		objectiveId: "objective-1",
		briefId: "brief-1",
		decisionId: null,
		riskLevel: "medium",
		state: "drafting",
		confidence: null,
		snapshotRef: null,
		...overrides,
	};
}

function laneRun(missionId: string, overrides: Partial<NewMissionLaneRun> = {}): NewMissionLaneRun {
	return {
		missionId,
		lane: "repo",
		agent: "Explore",
		epistemicRole: "repo_truth",
		status: "pending",
		evidenceCount: 0,
		emptyReason: null,
		taskId: null,
		startedAt: null,
		endedAt: null,
		...overrides,
	};
}

function researchRun(missionId: string, overrides: Partial<NewResearchRun> = {}): NewResearchRun {
	return {
		missionId,
		briefId: "brief-1",
		objectiveId: "objective-1",
		status: "running",
		completedAt: null,
		...overrides,
	};
}

function worldModel(
	missionId: string,
	overrides: Partial<NewMissionWorldModelRecord> = {},
): NewMissionWorldModelRecord {
	return {
		missionId,
		kind: "outcome",
		source: "task-attempt",
		sourceId: "task-1",
		claim: "explore completed after contract retry",
		evidenceRefs: ["verification-1", "task-attempt-1"],
		links: [],
		outcomeStatus: "pass",
		verified: true,
		...overrides,
	};
}

describe("MissionStore", () => {
	test("creates, gets, lists, and updates missions", () => {
		const store = createStore();
		const created = store.createMission(mission({ id: "mission-1" }));

		expect(created.id).toBe("mission-1");
		expect(created.createdAt).toBeNumber();
		expect(created.updatedAt).toBe(created.createdAt);
		expect(store.getMission("mission-1")).toEqual(created);
		expect(store.listMissions()).toEqual([created]);

		const updated = store.updateMission("mission-1", {
			state: "deciding",
			confidence: "high",
			decisionId: "decision-1",
			snapshotRef: "snapshot-1",
		});
		expect(updated).toEqual({
			...created,
			state: "deciding",
			confidence: "high",
			decisionId: "decision-1",
			snapshotRef: "snapshot-1",
			updatedAt: updated.updatedAt,
			revision: created.revision + 1,
		});
		expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
		expect(store.getMission("mission-1")).toEqual(updated);
	});

	test("listMissions filters by objectiveId, briefId, and state", () => {
		const store = createStore();
		const target = store.createMission(
			mission({ id: "mission-target", objectiveId: "objective-1", briefId: "brief-1", state: "researching" }),
		);
		store.createMission(mission({ id: "mission-other-objective", objectiveId: "objective-2", briefId: "brief-1" }));
		store.createMission(mission({ id: "mission-other-brief", objectiveId: "objective-1", briefId: "brief-2" }));
		store.createMission(
			mission({ id: "mission-other-state", objectiveId: "objective-1", briefId: "brief-1", state: "drafting" }),
		);

		expect(store.listMissions({ objectiveId: "objective-1", briefId: "brief-1", state: "researching" })).toEqual([
			target,
		]);
		expect(store.listMissions({ objectiveId: "objective-2" }).map(item => item.id)).toEqual([
			"mission-other-objective",
		]);
		expect(store.listMissions({ briefId: "brief-2" }).map(item => item.id)).toEqual(["mission-other-brief"]);
		expect(store.listMissions({ state: "drafting" }).map(item => item.id)).toContain("mission-other-state");
	});

	test("creates, lists, and updates lane runs", () => {
		const store = createStore();
		const createdMission = store.createMission(mission({ id: "mission-1" }));
		const first = store.createLaneRun(laneRun(createdMission.id, { id: "lane-1", startedAt: 10 }));
		const second = store.createLaneRun(
			laneRun(createdMission.id, {
				id: "lane-2",
				lane: "source",
				epistemicRole: "source_harvest",
				status: "running",
				startedAt: 20,
			}),
		);

		expect(store.listLaneRuns(createdMission.id)).toEqual([first, second]);

		const updated = store.updateLaneRun("lane-2", {
			status: "completed",
			evidenceCount: 3,
			taskId: "task-1",
			endedAt: 30,
		});
		expect(updated).toEqual({
			...second,
			status: "completed",
			evidenceCount: 3,
			taskId: "task-1",
			endedAt: 30,
		});
		expect(store.listLaneRuns(createdMission.id)).toEqual([first, updated]);
	});

	test("creates, gets, filters, and updates research runs", () => {
		const store = createStore();
		const createdMission = store.createMission(mission({ id: "mission-1" }));
		store.createMission(mission({ id: "mission-2", briefId: "brief-2" }));
		const first = store.createResearchRun(researchRun(createdMission.id, { id: "run-1", startedAt: 10 }));
		const second = store.createResearchRun(
			researchRun(createdMission.id, { id: "run-2", briefId: "brief-2", status: "blocked", startedAt: 20 }),
		);

		expect(store.getResearchRun("run-1")).toEqual(first);
		expect(store.getLatestResearchRunForMission(createdMission.id)).toEqual(second);
		expect(store.listResearchRuns({ missionId: createdMission.id })).toEqual([second, first]);
		expect(store.listResearchRuns({ briefId: "brief-1" })).toEqual([first]);
		expect(store.listResearchRuns({ status: "blocked" })).toEqual([second]);

		const updated = store.updateResearchRun("run-1", { status: "completed", completedAt: 30 });
		expect(updated).toEqual({ ...first, status: "completed", completedAt: 30 });
		expect(store.getResearchRun("run-1")).toEqual(updated);
	});

	test("persists and round-trips world-model records", () => {
		const store = createStore();
		const createdMission = store.createMission(mission({ id: "mission-world" }));

		const record = store.recordWorldModel(
			worldModel(createdMission.id, {
				id: "world-1",
				kind: "claim",
				source: "decision",
				sourceId: "decision-1",
				claim: "Decision was supported by repo evidence",
				evidenceRefs: ["ev-1"],
				verified: false,
				createdAt: 100,
			}),
		);

		expect(store.listWorldModel(createdMission.id)).toEqual([record]);
		expect(record).toEqual({
			id: "world-1",
			missionId: createdMission.id,
			kind: "claim",
			source: "decision",
			sourceId: "decision-1",
			claim: "Decision was supported by repo evidence",
			evidenceRefs: ["ev-1"],
			links: [],
			outcomeStatus: "pass",
			verified: false,
			createdAt: 100,
		});
	});

	test("finds latest lane runs by mission and lane", () => {
		const store = createStore();
		const createdMission = store.createMission(mission({ id: "mission-latest" }));
		const first = store.createLaneRun(laneRun(createdMission.id, { id: "lane-first", lane: "repo" }));
		const source = store.createLaneRun(
			laneRun(createdMission.id, { id: "lane-source", lane: "source", epistemicRole: "source_harvest" }),
		);
		const latest = store.createLaneRun(laneRun(createdMission.id, { id: "lane-latest", lane: "repo" }));

		expect(store.getLatestLaneRunForMissionLane(createdMission.id, "repo")).toEqual(latest);
		expect(store.getLatestLaneRunForMissionLane(createdMission.id, "source")).toEqual(source);
		expect(store.listLatestLaneRunsForMissionLanes(createdMission.id, ["repo", "source"])).toEqual([latest, source]);
		expect(first.id).toBe("lane-first");
	});

	test("validates mission enums and lane run enums", () => {
		const store = createStore();
		expect(() => store.createMission(mission({ state: "unknown" as any }))).toThrow("Invalid mission state");
		expect(() => store.createMission(mission({ riskLevel: "severe" as any }))).toThrow("Invalid mission risk level");
		expect(() => store.createMission(mission({ confidence: "certain" as any }))).toThrow(
			"Invalid mission confidence",
		);

		const createdMission = store.createMission(mission({ id: "mission-1" }));
		expect(() => store.createLaneRun(laneRun(createdMission.id, { lane: "bogus" as any }))).toThrow(
			"Invalid research lane",
		);
		expect(() => store.createLaneRun(laneRun(createdMission.id, { epistemicRole: "oracle" as any }))).toThrow(
			"Invalid epistemic role",
		);
		expect(() => store.createLaneRun(laneRun(createdMission.id, { status: "stuck" as any }))).toThrow(
			"Invalid mission lane status",
		);
		expect(() => store.updateMission(createdMission.id, { state: "unknown" as any })).toThrow(
			"Invalid mission state",
		);
		expect(() => store.createResearchRun(researchRun(createdMission.id, { status: "paused" as any }))).toThrow(
			"Invalid research run status",
		);
	});

	test("lane runs require an existing mission", () => {
		const store = createStore();
		expect(() => store.createLaneRun(laneRun("missing"))).toThrow("Mission not found");
	});

	test("schema initialization is idempotent for file databases", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-store-"));
		const dbPath = path.join(root, "autonomy.db");
		try {
			const first = createStore(dbPath);
			first.createMission(mission({ id: "mission-1" }));
			first.close();
			stores.splice(stores.indexOf(first), 1);

			const second = createStore(dbPath);
			expect(second.getMission("mission-1")?.id).toBe("mission-1");
			second.createLaneRun(laneRun("mission-1", { id: "lane-1" }));
			expect(second.listLaneRuns("mission-1").map(run => run.id)).toEqual(["lane-1"]);
			second.createResearchRun(researchRun("mission-1", { id: "run-1" }));
			expect(second.listResearchRuns({ missionId: "mission-1" }).map(run => run.id)).toEqual(["run-1"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	test("emits lane started and completed events when a mission event bus is supplied", () => {
		const bus = new MissionEventBus();
		const store = new MissionStore(":memory:", bus);
		stores.push(store);
		const createdMission = store.createMission(mission({ id: "mission-events" }));

		const run = store.createLaneRun(
			laneRun(createdMission.id, {
				id: "lane-events",
				status: "running",
				startedAt: 100,
			}),
		);
		store.updateLaneRun(run.id, {
			status: "completed",
			evidenceCount: 4,
			endedAt: 200,
		});

		expect(bus.snapshot()).toEqual([
			{
				type: "research.lane.started",
				missionId: createdMission.id,
				laneRunId: run.id,
				lane: "repo",
				agent: "Explore",
				epistemicRole: "repo_truth",
				ts: 100,
			},
			{
				type: "research.lane.completed",
				missionId: createdMission.id,
				laneRunId: run.id,
				lane: "repo",
				status: "completed",
				evidenceCount: 4,
				emptyReason: null,
				ts: 200,
			},
		]);
	});
});
