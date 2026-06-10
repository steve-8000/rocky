import { describe, expect, test } from "bun:test";
import { projectMissionView } from "../../src/mission/projection";
import type { MissionLaneRun, ResearchCampaign } from "../../src/mission/types";
import type { DecisionRecord, EvidenceCard, ResearchBrief } from "../../src/research/types";

function mission(overrides: Partial<ResearchCampaign> = {}): ResearchCampaign {
	return {
		id: "mission-1",
		title: "Decide safely",
		objectiveId: null,
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
		objectiveId: null,
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
		evidenceRefs: [],
		rejectedOptions: [],
		nextActions: [],
		createdAt: 1,
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
		taskId: null,
		startedAt: 1,
		endedAt: 2,
		...overrides,
	};
}

describe("projectMissionView", () => {
	test("zero evidence yields three-lane zero counts", () => {
		const view = projectMissionView({
			mission: mission(),
			brief: brief(),
			decision: decision(),
			evidence: [],
			laneRuns: [],
		});

		expect(view.evidenceCount).toBe(0);
		expect(view.evidenceByLane).toEqual([
			{ lane: "repo", count: 0 },
			{ lane: "source", count: 0 },
			{ lane: "social", count: 0 },
		]);
	});

	test("populated evidence groups by lane", () => {
		const view = projectMissionView({
			mission: mission(),
			brief: brief(),
			decision: decision(),
			evidence: [
				card({ id: "repo-1", lane: "repo" }),
				card({ id: "repo-2", lane: "repo" }),
				card({ id: "social-1", lane: "social" }),
			],
			laneRuns: [],
		});

		expect(view.evidenceCount).toBe(3);
		expect(view.evidenceByLane).toEqual([
			{ lane: "repo", count: 2 },
			{ lane: "source", count: 0 },
			{ lane: "social", count: 1 },
		]);
	});

	test("undefined brief and decision project to null", () => {
		const view = projectMissionView({
			mission: mission(),
			brief: undefined,
			decision: undefined,
			evidence: [],
			laneRuns: [],
		});

		expect(view.brief).toBeNull();
		expect(view.decision).toBeNull();
	});

	test("lane runs sort by startedAt with id tie-break and project summaries", () => {
		const view = projectMissionView({
			mission: mission(),
			brief: brief(),
			decision: decision(),
			evidence: [],
			laneRuns: [
				laneRun({ id: "run-c", lane: "social", epistemicRole: "social_signal", startedAt: 20 }),
				laneRun({
					id: "run-b",
					lane: "source",
					epistemicRole: "source_harvest",
					startedAt: null,
					status: "running",
				}),
				laneRun({
					id: "run-a",
					lane: "repo",
					epistemicRole: "repo_truth",
					startedAt: null,
					status: "empty",
					evidenceCount: 0,
					emptyReason: "no prior",
				}),
			],
		});

		expect(view.laneRuns).toEqual([
			{
				lane: "repo",
				status: "empty",
				agent: "Explore",
				epistemicRole: "repo_truth",
				evidenceCount: 0,
				emptyReason: "no prior",
				taskId: null,
				startedAt: null,
				endedAt: 2,
			},
			{
				lane: "source",
				status: "running",
				agent: "Explore",
				epistemicRole: "source_harvest",
				evidenceCount: 1,
				emptyReason: null,
				taskId: null,
				startedAt: null,
				endedAt: 2,
			},
			{
				lane: "social",
				status: "completed",
				agent: "Explore",
				epistemicRole: "social_signal",
				evidenceCount: 1,
				emptyReason: null,
				taskId: null,
				startedAt: 20,
				endedAt: 2,
			},
		]);
	});
});
