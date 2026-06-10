import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recordProposalApplyRollbackAnchor, recordProposalRollbackAnchor } from "../../src/cli/proposals";
import { ProposalStore } from "../../src/learning";
import { MissionStore } from "../../src/mission/store";
import type { NewResearchCampaign } from "../../src/mission/types";
import { ResearchStore } from "../../src/research/store";
import { evaluateRuntimeCriticGate, recordTaskMissionContract } from "../../src/task";

const stores: MissionStore[] = [];
let cleanupRoot: string | undefined;

afterEach(async () => {
	for (const store of stores.splice(0).reverse()) store.close();
	if (cleanupRoot) {
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

function mission(overrides: Partial<NewResearchCampaign> = {}): NewResearchCampaign {
	return {
		title: "Producer mission",
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

describe("mission write-side producers", () => {
	test("does not record task contracts by title without an exact mission link", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-task-producer-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const store = new MissionStore(db);
		stores.push(store);
		const createdMission = store.createMission(mission({ id: "mission-task", title: "Task objective" }));
		recordTaskMissionContract(
			"Task objective",
			{
				role: "producer",
				parentMissionRev: 2,
				scope: { include: ["src/**"], exclude: ["docs/**"] },
				successCriteria: [
					{
						id: "checkts",
						description: "typecheck",
						check: { type: "command-exit", command: "bun run check:ts", expected: 0 },
					},
				],
				escalation: { onUncertainty: "ask-parent", budgetCap: 42 },
				inputArtifact: "local://contract.md",
				outputContract: { mustProduce: ["changed files"] },
			},
			db,
			{ taskId: "producer-task", sessionFile: "/tmp/producer-task.jsonl", missionId: createdMission.id },
		);

		expect(store.listContracts(createdMission.id)).toMatchObject([
			{
				missionId: createdMission.id,
				role: "producer",
				parentMissionRev: 2,
				include: ["src/**"],
				exclude: ["docs/**"],
				successCriteria: ["checkts"],
				escalation: { onUncertainty: "ask-parent", budgetCap: 42 },
				inputArtifact: "local://contract.md",
				mustProduce: ["changed files"],
				taskId: "producer-task",
				sessionFile: "/tmp/producer-task.jsonl",
			},
		]);
	});

	test("runtime critic gate blocks delegation and records dialogue for blocking checks", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-critic-gate-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const research = new ResearchStore(db);
		const brief = research.createBrief({
			id: "brief-critic-gate",
			objectiveId: "objective-critic-gate",
			question: "Need repo evidence before delegation?",
			lanes: ["repo"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "medium",
			stopCriteria: [],
		});
		research.close();
		const store = new MissionStore(db);
		stores.push(store);
		const mission = store.listMissions({ briefId: brief.id })[0]!;

		const gate = evaluateRuntimeCriticGate({
			goalObjective: mission.title,
			missionId: mission.id,
			dbPath: db,
			action: "task",
		});

		expect(gate).toEqual({
			ok: false,
			reason:
				"Runtime critic blocked task from runtime critic check: Required research lane has no evidence: repo. Required action: collect-evidence.",
		});
		expect(store.listCriticDialogue(mission.id)).toHaveLength(2);
	});

	test("runtime critic gate prefers persisted structured critique blockers", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-structured-critic-gate-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const research = new ResearchStore(db);
		const brief = research.createBrief({
			id: "brief-structured-critic-gate",
			objectiveId: "objective-structured-critic-gate",
			question: "Should execution proceed?",
			lanes: ["repo", "source"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "medium",
			stopCriteria: [],
		});
		research.addEvidence({
			briefId: brief.id,
			id: "ev-repo",
			lane: "repo",
			grade: "A",
			sourceRef: "src/file.ts:1",
			excerpt: "Repo evidence exists.",
			claims: ["repo evidence"],
			directness: 1,
			specificity: 1,
			recency: 1,
			reproducibility: 1,
		});
		research.recordCritique({
			briefId: brief.id,
			blockingCount: 0,
			softCount: 0,
			verdict: "needs-more-research",
			summary: "Need source proof.",
			rawOutput: "raw",
			findings: [
				{
					id: "finding-source-proof",
					severity: "blocking",
					message: "Structured critique requires source proof before delegation.",
					evidenceRefs: ["ev-repo"],
					requiredAction: "collect-evidence",
				},
			],
		});
		research.close();
		const store = new MissionStore(db);
		stores.push(store);
		const mission = store.listMissions({ briefId: brief.id })[0]!;

		const gate = evaluateRuntimeCriticGate({
			goalObjective: mission.title,
			missionId: mission.id,
			dbPath: db,
			action: "task",
		});

		expect(gate).toEqual({
			ok: false,
			reason:
				"Runtime critic blocked task from structured critique finding: Structured critique requires source proof before delegation. Required action: collect-evidence.",
		});
		expect(store.listCriticDialogue(mission.id).at(-1)).toMatchObject({
			summary: "critique-finding: Structured critique requires source proof before delegation.",
		});
	});

	test("records goal verification and updates mission state", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-goal-producer-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const store = new MissionStore(db);
		stores.push(store);
		const createdMission = store.createMission(
			mission({ id: "mission-goal", title: "Goal objective", state: "verifying" }),
		);

		store.recordVerification({
			missionId: createdMission.id,
			status: "pass",
			failedCount: 0,
			uncertainCount: 0,
			summary: "ok",
		});

		expect(store.getLatestVerification(createdMission.id)).toMatchObject({
			missionId: createdMission.id,
			status: "pass",
			failedCount: 0,
			uncertainCount: 0,
			summary: "ok",
		});
	});

	test("records task contracts by explicit mission id before title lookup", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-task-id-producer-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const store = new MissionStore(db);
		stores.push(store);
		const byTitle = store.createMission(mission({ id: "mission-title", title: "Shared objective" }));
		const byId = store.createMission(mission({ id: "mission-id", title: "Different objective" }));

		recordTaskMissionContract(
			"Shared objective",
			{
				role: "producer",
				parentMissionRev: 2,
				scope: { include: ["src/**"], exclude: [] },
				successCriteria: [],
				escalation: { onUncertainty: "ask-parent", budgetCap: 42 },
				inputArtifact: undefined,
				outputContract: { mustProduce: [] },
			},
			db,
			{ missionId: byId.id },
		);

		expect(store.listContracts(byTitle.id)).toHaveLength(0);
		expect(store.listContracts(byId.id)).toMatchObject([{ missionId: byId.id, role: "producer" }]);
	});

	test("records goal verification by explicit mission id before title lookup", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-goal-id-producer-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const store = new MissionStore(db);
		stores.push(store);
		const byTitle = store.createMission(mission({ id: "mission-verify-title", title: "Shared objective" }));
		const byId = store.createMission(
			mission({ id: "mission-verify-id", title: "Different objective", state: "verifying" }),
		);

		store.recordVerification({
			missionId: byId.id,
			status: "fail",
			failedCount: 1,
			uncertainCount: 0,
			summary: "not ok",
		});

		expect(store.getLatestVerification(byTitle.id)).toBeUndefined();
		expect(store.getLatestVerification(byId.id)).toMatchObject({
			missionId: byId.id,
			status: "fail",
			summary: "not ok",
		});
	});

	test("does not fall back to title when explicit task mission id is missing", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-task-id-fallback-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const store = new MissionStore(db);
		stores.push(store);
		const byTitle = store.createMission(mission({ id: "mission-task-title-fallback", title: "Fallback objective" }));

		recordTaskMissionContract(
			"Fallback objective",
			{
				role: "producer",
				parentMissionRev: undefined,
				scope: { include: ["src/**"], exclude: [] },
				successCriteria: [],
				escalation: { onUncertainty: "ask-parent", budgetCap: 42 },
				inputArtifact: undefined,
				outputContract: { mustProduce: [] },
			},
			db,
			{ missionId: "missing-mission" },
		);

		expect(store.listContracts(byTitle.id)).toHaveLength(0);
	});

	test("does not fall back to title when explicit verification mission id is missing", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-goal-id-fallback-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const store = new MissionStore(db);
		stores.push(store);
		const byTitle = store.createMission(
			mission({ id: "mission-verify-title-fallback", title: "Fallback verify objective", state: "verifying" }),
		);

		expect(() =>
			store.recordVerification({
				missionId: "missing-mission",
				status: "pass",
				failedCount: 0,
				uncertainCount: 0,
				summary: "ok",
			}),
		).toThrow();

		expect(store.getLatestVerification(byTitle.id)).toBeUndefined();
		expect(store.getMission(byTitle.id)?.state).toBe("verifying");
	});

	test("records proposal apply and rollback anchors by objective provenance", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mission-proposal-producer-"));
		const db = path.join(cleanupRoot, "autonomy.db");
		const missionStore = new MissionStore(db);
		stores.push(missionStore);
		const createdMission = missionStore.createMission(
			mission({ id: "mission-proposal", objectiveId: "objective-proposal", state: "contracted" }),
		);
		const proposalStore = new ProposalStore(db);
		const proposal = proposalStore.create({
			type: "settings",
			gate: "human-required",
			evidence: { sessionIds: ["session-1"], eventRefs: [], sampleN: 1 },
			provenance: { source: "manual", objectiveId: "objective-proposal" } as any,
			patch: { model: "fast" },
			reason: "test",
			rollback: { model: "slow" },
		});
		try {
			recordProposalApplyRollbackAnchor(proposalStore, proposal.id, { snapshotRef: "snapshot-1", version: "v1" });
			recordProposalRollbackAnchor(proposalStore, proposal.id, proposal.provenance);
		} finally {
			proposalStore.close();
		}

		expect(missionStore.getMission(createdMission.id)).toMatchObject({
			state: "rolled_back",
			snapshotRef: "snapshot-1",
		});
		const rollbacks = missionStore.listRollbacks(createdMission.id);
		expect(rollbacks).toHaveLength(2);
		expect(rollbacks).toContainEqual(
			expect.objectContaining({
				missionId: createdMission.id,
				targetType: "proposal",
				targetId: proposal.id,
				snapshotRef: "snapshot-1",
				summary: `Applied proposal ${proposal.id} version v1`,
			}),
		);
		expect(rollbacks).toContainEqual(
			expect.objectContaining({
				missionId: createdMission.id,
				targetType: "proposal",
				targetId: proposal.id,
				snapshotRef: null,
				summary: `Rolled back proposal ${proposal.id}`,
			}),
		);
	});
});
