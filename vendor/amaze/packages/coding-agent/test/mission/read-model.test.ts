import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObjectiveStore } from "../../src/autonomy/store";
import { type NewLearningProposal, ProposalStore } from "../../src/learning";
import { buildMissionView, deriveMissionPolicyGuidance, MissionReadModel } from "../../src/mission/read-model";
import { MissionStore } from "../../src/mission/store";
import type { MissionLaneRun, MissionWorldModelRecord, ResearchCampaign, ResearchRun } from "../../src/mission/types";
import { ResearchStore } from "../../src/research/store";
import type { DecisionRecord, EvidenceCard, ResearchBrief } from "../../src/research/types";

const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const item of cleanup.splice(0).reverse()) {
		item();
	}
});

function tempDb(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-read-model-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return path.join(root, "autonomy.db");
}

function mission(overrides: Partial<ResearchCampaign> = {}): ResearchCampaign {
	return {
		id: "mission-1",
		title: "Decide safely",
		objectiveId: "objective-1",
		briefId: "brief-1",
		decisionId: null,
		riskLevel: "medium",
		state: "researching",
		confidence: null,
		snapshotRef: null,
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		...overrides,
	};
}

function brief(overrides: Partial<ResearchBrief> = {}): ResearchBrief {
	return {
		id: "brief-1",
		objectiveId: "objective-1",
		question: "What is true?",
		lanes: ["repo", "source", "social"],
		requiredEvidence: [],
		disallowedEvidence: [],
		riskLevel: "medium",
		stopCriteria: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		id: "decision-1",
		briefId: "brief-1",
		hypothesis: "Ship it",
		rationale: "Evidence supports it",
		kind: "select",
		confidence: "high",
		evidenceRefs: ["ev-1"],
		rejectedOptions: [],
		nextActions: [],
		createdAt: 7,
		...overrides,
	};
}

function card(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
	return {
		id: "ev-1",
		briefId: "brief-1",
		lane: "repo",
		grade: "A",
		sourceRef: "src/file.ts:1",
		excerpt: "evidence",
		claims: ["claim"],
		capturedAt: 1,
		directness: 1,
		specificity: 1,
		recency: 1,
		reproducibility: 1,
		...overrides,
	};
}

function laneRun(overrides: Partial<MissionLaneRun> = {}): MissionLaneRun {
	return {
		id: "run-1",
		missionId: "mission-1",
		lane: "repo",
		agent: "Explore",
		epistemicRole: "repo_truth",
		status: "completed",
		evidenceCount: 1,
		emptyReason: null,
		taskId: "task-1",
		startedAt: 1,
		endedAt: 2,
		...overrides,
	};
}

function worldModelRecord(overrides: Partial<MissionWorldModelRecord> = {}): MissionWorldModelRecord {
	return {
		id: "world-1",
		missionId: "mission-1",
		kind: "outcome",
		source: "task-attempt",
		sourceId: "task-1",
		claim: "explore completed with passing verification",
		evidenceRefs: ["verification-1"],
		links: [],
		outcomeStatus: "pass",
		verified: true,
		createdAt: 4,
		...overrides,
	};
}

function researchRun(overrides: Partial<ResearchRun> = {}): ResearchRun {
	return {
		id: "research-run-1",
		missionId: "mission-1",
		briefId: "brief-1",
		objectiveId: "objective-1",
		status: "running",
		startedAt: 3,
		completedAt: null,
		...overrides,
	};
}

function memoryProposal(overrides: Partial<NewLearningProposal> = {}): NewLearningProposal {
	return {
		type: "memory",
		gate: "review",
		evidence: { sessionIds: ["session-1"], eventRefs: ["events.jsonl:12"], sampleN: 1 },
		provenance: { source: "manual" },
		content: "Prefer narrow tests for changed behavior.",
		memoryType: "project",
		confidence: "tool_verified",
		...overrides,
	} as NewLearningProposal;
}

describe("buildMissionView", () => {
	test("maps objective, decision, and proposal summaries", () => {
		const view = buildMissionView({
			mission: mission(),
			brief: brief(),
			decision: decision(),
			evidence: [card()],
			laneRuns: [laneRun()],
			objective: {
				id: "objective-1",
				title: "Improve autonomy",
				status: "active",
				metricTargets: [],
				budget: {},
				guardrails: { requireHumanForApply: true, maxAutoSubgoalsPerDay: 1, forbiddenScopes: [] },
			},
			proposals: [
				{
					id: "proposal-b",
					createdAt: 20,
					status: "pending",
					gate: "review",
					evidence: { sessionIds: [], eventRefs: [], sampleN: 1 },
					provenance: { source: "reflection", objectiveId: "objective-1" } as any,
					type: "memory",
					content: "later",
					memoryType: "project",
					confidence: "tool_verified",
				} as any,
				{
					id: "proposal-a",
					createdAt: 10,
					status: "approved",
					gate: "auto",
					evidence: { sessionIds: [], eventRefs: [], sampleN: 1 },
					provenance: { source: "reflection", objectiveId: "objective-1" } as any,
					type: "rule",
					ruleMarkdown: "# rule",
					replaySessions: [],
					expectedImpact: "better",
				} as any,
			],
			contracts: [],
			latestVerification: undefined,
			rollbacks: [],
			researchRun: researchRun(),
			worldModel: [worldModelRecord()],
			taskAttemptCheckpoints: [
				{
					id: "attempt-1",
					missionId: "mission-1",
					taskId: "task-1",
					agent: "Explore",
					role: "repo explorer",
					attempt: 1,
					status: "completed",
					failureMode: null,
					lastVerdict: "pass",
					failedCount: 0,
					uncertainCount: 0,
					remediationAction: "resume",
					sessionFile: null,
					artifactRefs: [],
					error: null,
					createdAt: 4,
					updatedAt: 4,
				},
			],
		});

		expect(view.objective).toEqual({ id: "objective-1", title: "Improve autonomy", status: "active", updatedAt: 0 });
		expect(view.decisionSummary).toEqual({
			id: "decision-1",
			kind: "select",
			confidence: "high",
			createdAt: 7,
			evidenceRefs: ["ev-1"],
			hypothesis: "Ship it",
		});
		expect(view.proposals).toEqual([
			{
				id: "proposal-a",
				type: "rule",
				status: "approved",
				gate: "auto",
				createdAt: 10,
				updatedAt: 10,
				objectiveId: "objective-1",
			},
			{
				id: "proposal-b",
				type: "memory",
				status: "pending",
				gate: "review",
				createdAt: 20,
				updatedAt: 20,
				objectiveId: "objective-1",
			},
		]);
		expect(view.contracts).toEqual([]);
		expect(view.latestVerification).toBeNull();
		expect(view.rollbacks).toEqual([]);
		expect(view.researchRun).toEqual(researchRun());
		expect(view.runtimeCriticChecks).toEqual([]);
		expect(view.uncertaintyMap).toBeNull();
		expect(view.worldModel).toEqual([worldModelRecord()]);
		expect(view.policyGuidance).toEqual({
			missionId: "mission-1",
			verifiedOutcomeCount: 1,
			recommendedAgents: ["Explore"],
			retryPolicy: "standard",
			laneMix: ["repo"],
			rationale: ["explore completed with passing verification"],
		});
	});
});

describe("deriveMissionPolicyGuidance", () => {
	test("uses verified outcomes and ignores speculative world-model inputs", () => {
		const guidance = deriveMissionPolicyGuidance(
			"mission-1",
			[
				worldModelRecord({
					sourceId: "task-good",
					verified: true,
					claim: "repo lane succeeded after verification",
				}),
				worldModelRecord({
					id: "world-speculative",
					sourceId: "task-speculative",
					verified: false,
					claim: "source lane might be useful",
				}),
			],
			[
				{
					id: "attempt-good",
					missionId: "mission-1",
					taskId: "task-good",
					agent: "Explore",
					role: "repo explorer",
					attempt: 1,
					status: "completed",
					failureMode: null,
					lastVerdict: "pass",
					failedCount: 0,
					uncertainCount: 0,
					remediationAction: "resume",
					sessionFile: null,
					artifactRefs: [],
					error: null,
					createdAt: 1,
					updatedAt: 1,
				},
				{
					id: "attempt-speculative",
					missionId: "mission-1",
					taskId: "task-speculative",
					agent: "Resercher",
					role: "researcher",
					attempt: 1,
					status: "completed",
					failureMode: null,
					lastVerdict: null,
					failedCount: 0,
					uncertainCount: 0,
					remediationAction: "resume",
					sessionFile: null,
					artifactRefs: [],
					error: null,
					createdAt: 2,
					updatedAt: 2,
				},
			],
			[
				laneRun({ id: "lane-good", taskId: "task-good", lane: "repo" }),
				laneRun({ id: "lane-speculative", taskId: "task-speculative", lane: "source" }),
			],
		);

		expect(guidance).toEqual({
			missionId: "mission-1",
			verifiedOutcomeCount: 1,
			recommendedAgents: ["Explore"],
			retryPolicy: "standard",
			laneMix: ["repo"],
			rationale: ["repo lane succeeded after verification"],
		});
	});
});

describe("MissionReadModel", () => {
	test("joins mission, brief, decision, objective, evidence, lane runs, and proposals", () => {
		const dbPath = tempDb();
		const objectives = new ObjectiveStore(dbPath);
		const research = new ResearchStore(dbPath);
		const proposals = new ProposalStore(dbPath);
		cleanup.push(
			() => proposals.close(),
			() => research.close(),
			() => objectives.close(),
		);

		const objective = objectives.create({ title: "Improve autonomy", metricTargets: [], budget: {}, guardrails: {} });
		const createdBrief = research.createBrief({
			objectiveId: objective.id,
			question: "Should we ship?",
			lanes: ["repo"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "medium",
			stopCriteria: [],
		});
		const evidence = research.addEvidence({
			briefId: createdBrief.id,
			lane: "repo",
			grade: "A",
			sourceRef: "src/file.ts:1",
			excerpt: "strong evidence",
			claims: ["claim"],
			directness: 1,
			specificity: 1,
			recency: 1,
			reproducibility: 1,
		});
		const recordedDecision = research.recordDecision({
			briefId: createdBrief.id,
			hypothesis: "Ship it",
			rationale: "Evidence supports it",
			kind: "select",
			confidence: "high",
			evidenceRefs: [evidence.id],
			rejectedOptions: [],
			nextActions: [],
		});
		const proposal = proposals.create(
			memoryProposal({ provenance: { source: "reflection", objectiveId: objective.id } as any }),
		);
		const missionStore = new MissionStore(dbPath);
		cleanup.push(() => missionStore.close());
		const mission = missionStore.listMissions({ briefId: createdBrief.id })[0];
		const contract = missionStore.recordContract({
			missionId: mission.id,
			role: "wave5-contracts",
			parentMissionRev: 1,
			include: ["src/a.ts"],
			exclude: ["docs/**"],
			successCriteria: ["checkts"],
			escalation: { onUncertainty: "ask-parent", budgetCap: 1200 },
			inputArtifact: null,
			mustProduce: ["changed files"],
			createdAt: 10,
		});
		const oldRun = missionStore.createResearchRun({
			missionId: mission.id,
			briefId: createdBrief.id,
			objectiveId: objective.id,
			status: "completed",
			startedAt: 10,
			completedAt: 15,
		});
		const latestRun = missionStore.createResearchRun({
			missionId: mission.id,
			briefId: createdBrief.id,
			objectiveId: objective.id,
			status: "running",
			startedAt: 20,
			completedAt: null,
		});
		const verification = missionStore.recordVerification({
			missionId: mission.id,
			status: "fail",
			failedCount: 1,
			uncertainCount: 2,
			summary: "one check failed",
			createdAt: 20,
		});
		const rollback = missionStore.recordRollback({
			missionId: mission.id,
			targetType: "proposal",
			targetId: proposal.id,
			snapshotRef: "snapshot-1",
			summary: "rollback proposal",
			createdAt: 30,
		});
		missionStore.recordTaskAttemptCheckpoint({
			missionId: mission.id,
			taskId: "task-verified",
			agent: "Explore",
			role: "repo explorer",
			attempt: 1,
			status: "completed",
			failureMode: null,
			lastVerdict: "pass",
			failedCount: 0,
			uncertainCount: 0,
			remediationAction: "resume",
			sessionFile: null,
			artifactRefs: [verification.id],
			error: null,
			createdAt: 40,
		});
		missionStore.createLaneRun({
			missionId: mission.id,
			lane: "repo",
			agent: "Explore",
			epistemicRole: "repo_truth",
			status: "completed",
			evidenceCount: 1,
			emptyReason: null,
			taskId: "task-verified",
			startedAt: 35,
			endedAt: 40,
		});
		const worldModel = missionStore.recordWorldModel({
			missionId: mission.id,
			kind: "outcome",
			source: "task-attempt",
			sourceId: "task-verified",
			claim: "explore completed the verified repo task",
			evidenceRefs: [verification.id],
			links: [{ targetId: verification.id, type: "evidence-for" }],
			outcomeStatus: "pass",
			verified: true,
			createdAt: 45,
		});

		const readModel = new MissionReadModel({ dbPath });
		cleanup.push(() => readModel.close());
		const view = readModel.getMissionView(mission.id);

		expect(view?.mission.id).toBe(mission.id);
		expect(view?.brief?.id).toBe(createdBrief.id);
		expect(view?.decision?.id).toBe(recordedDecision.id);
		expect(view?.decisionSummary?.evidenceRefs).toEqual([evidence.id]);
		expect(view?.objective).toEqual({ id: objective.id, title: "Improve autonomy", status: "active", updatedAt: 0 });
		expect(view?.evidenceCount).toBe(1);
		expect(view?.proposals).toEqual([
			{
				id: proposal.id,
				type: "memory",
				status: "pending",
				gate: "review",
				createdAt: proposal.createdAt,
				updatedAt: proposal.createdAt,
				objectiveId: objective.id,
			},
		]);
		expect(view?.contracts).toEqual([contract]);
		expect(view?.latestVerification).toEqual(verification);
		expect(view?.rollbacks).toEqual([rollback]);
		expect(view?.researchRun).toEqual(latestRun);
		expect(view?.researchRun?.id).not.toBe(oldRun.id);
		expect(view?.runtimeCriticChecks).toEqual([]);
		expect(view?.uncertaintyMap?.parts).toEqual([
			expect.objectContaining({ lane: "repo", status: "satisfied", evidenceCount: 1 }),
		]);
		expect(view?.worldModel).toEqual([worldModel]);
		expect(view?.policyGuidance).toEqual({
			missionId: mission.id,
			verifiedOutcomeCount: 1,
			recommendedAgents: ["Explore"],
			retryPolicy: "standard",
			laneMix: ["repo"],
			rationale: ["explore completed the verified repo task"],
		});
	});
	test("derives runtime critic data without persisting read-side mutations", () => {
		const dbPath = tempDb();
		const research = new ResearchStore(dbPath);
		const missions = new MissionStore(dbPath);
		cleanup.push(
			() => missions.close(),
			() => research.close(),
		);

		const createdBrief = research.createBrief({
			objectiveId: null,
			question: "Do we have enough evidence?",
			lanes: ["repo", "source"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "medium",
			stopCriteria: [],
		});
		research.addEvidence({
			briefId: createdBrief.id,
			lane: "repo",
			grade: "A",
			sourceRef: "src/file.ts:1",
			excerpt: "repo signal",
			claims: ["claim"],
			directness: 1,
			specificity: 1,
			recency: 1,
			reproducibility: 1,
		});
		const mission = missions.listMissions({ briefId: createdBrief.id })[0]!;

		expect(research.listRuntimeCriticChecks(createdBrief.id)).toEqual([]);

		const readModel = new MissionReadModel({ dbPath });
		cleanup.push(() => readModel.close());
		const view = readModel.getMissionView(mission.id);

		expect(view?.runtimeCriticChecks).toEqual([
			expect.objectContaining({
				trigger: "missing-lane-evidence",
				severity: "blocking",
				requiredAction: "collect-evidence",
				lane: "source",
			}),
		]);
		expect(view?.uncertaintyMap?.parts).toEqual([
			expect.objectContaining({ lane: "repo", status: "satisfied", evidenceCount: 1 }),
			expect.objectContaining({ lane: "source", status: "uncertain", evidenceCount: 0 }),
		]);
		expect(research.listRuntimeCriticChecks(createdBrief.id)).toEqual([]);
	});

	test("listMissionViews filters by objectiveId and state", () => {
		const dbPath = tempDb();
		const missions = new MissionStore(dbPath);
		cleanup.push(() => missions.close());
		const target = missions.createMission(mission({ id: "mission-target", state: "researching" }));
		missions.createMission(
			mission({ id: "mission-other-objective", objectiveId: "objective-2", state: "researching" }),
		);
		missions.createMission(mission({ id: "mission-other-state", state: "drafting" }));
		const readModel = new MissionReadModel({ dbPath });
		cleanup.push(() => readModel.close());

		expect(
			readModel.listMissionViews({ objectiveId: "objective-1", state: "researching" }).map(view => view.mission.id),
		).toEqual([target.id]);
	});

	test("getPreferredMissionView favors active mission over newer terminal mission", () => {
		const dbPath = tempDb();
		const missions = new MissionStore(dbPath);
		cleanup.push(() => missions.close());
		const active = missions.createMission(
			mission({ id: "mission-active", title: "Keep working", state: "researching", createdAt: 10, updatedAt: 10 }),
		);
		missions.createMission(
			mission({ id: "mission-terminal", title: "Done later", state: "completed", createdAt: 20, updatedAt: 20 }),
		);
		const readModel = new MissionReadModel({ dbPath });
		cleanup.push(() => readModel.close());

		expect(readModel.getPreferredMissionView()?.mission.id).toBe(active.id);
	});

	test("getPreferredMissionView title preference selects matching mission", () => {
		const dbPath = tempDb();
		const missions = new MissionStore(dbPath);
		cleanup.push(() => missions.close());
		missions.createMission(mission({ id: "mission-other", title: "Other mission", createdAt: 20, updatedAt: 20 }));
		const matching = missions.createMission(
			mission({ id: "mission-matching-title", title: "Match this goal", createdAt: 10, updatedAt: 10 }),
		);
		const readModel = new MissionReadModel({ dbPath });
		cleanup.push(() => readModel.close());

		expect(readModel.getPreferredMissionView({ title: "Match this goal" })?.mission.id).toBe(matching.id);
	});

	test("mission without brief yields empty evidence and proposals", () => {
		const dbPath = tempDb();
		const missions = new MissionStore(dbPath);
		cleanup.push(() => missions.close());
		const created = missions.createMission(
			mission({ id: "mission-no-brief", objectiveId: null, briefId: null, decisionId: null, state: "drafting" }),
		);
		const readModel = new MissionReadModel({ dbPath });
		cleanup.push(() => readModel.close());

		const view = readModel.getMissionView(created.id);

		expect(view?.brief).toBeNull();
		expect(view?.decision).toBeNull();
		expect(view?.decisionSummary).toBeNull();
		expect(view?.evidenceCount).toBe(0);
		expect(view?.proposals).toEqual([]);
		expect(view?.runtimeCriticChecks).toEqual([]);
		expect(view?.uncertaintyMap).toBeNull();
	});
});
