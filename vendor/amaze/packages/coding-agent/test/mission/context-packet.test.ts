import { describe, expect, test } from "bun:test";
import { buildActiveMissionPacket, renderActiveMissionPacket } from "../../src/mission/context-packet";
import type { MissionView } from "../../src/mission/read-model";

function missionView(): MissionView {
	const now = 10;
	return {
		mission: {
			id: "mission-1",
			title: "Mission title",
			objectiveId: "objective-1",
			briefId: "brief-1",
			decisionId: "decision-1",
			riskLevel: "medium",
			state: "critiquing",
			confidence: "medium",
			snapshotRef: null,
			createdAt: now,
			updatedAt: now,
			revision: 1,
		},
		brief: null,
		decision: {
			id: "decision-1",
			briefId: "brief-1",
			hypothesis: "Use the compact path",
			rationale: "RAW_DECISION_RATIONALE_SHOULD_NOT_APPEAR",
			kind: "select",
			confidence: "high",
			evidenceRefs: ["ev-1"],
			rejectedOptions: [{ id: "reject-1", reason: "RAW_REJECTED_OPTION_SHOULD_NOT_APPEAR" }],
			nextActions: ["act-1", "act-2", "act-3", "act-4", "act-5", "act-6"],
			createdAt: now,
		},
		evidenceCount: 7,
		evidenceByLane: [{ lane: "repo", count: 7 }],
		laneRuns: [],
		objective: { id: "objective-1", title: "Objective title", status: "active", updatedAt: now },
		decisionSummary: {
			id: "decision-1",
			kind: "select",
			confidence: "high",
			createdAt: now,
			evidenceRefs: ["ev-1"],
			hypothesis: "Use the compact path",
		},
		proposals: [],
		contracts: [
			{
				id: "contract-old",
				missionId: "mission-1",
				role: "old-role",
				parentMissionRev: null,
				include: ["old/**"],
				exclude: [],
				successCriteria: [],
				escalation: { onUncertainty: "ask-parent", budgetCap: 1 },
				inputArtifact: null,
				mustProduce: [],
				taskId: null,
				sessionFile: null,
				createdAt: now,
			},
			{
				id: "contract-active",
				missionId: "mission-1",
				role: "active-role",
				parentMissionRev: 2,
				include: ["a", "b", "c", "d"],
				exclude: ["RAW_EXCLUDE_SHOULD_NOT_APPEAR"],
				successCriteria: ["one", "two", "three", "four", "five", "six"],
				escalation: { onUncertainty: "block", budgetCap: 2 },
				inputArtifact: "RAW_INPUT_ARTIFACT_SHOULD_NOT_APPEAR",
				mustProduce: ["changed files"],
				taskId: "RAW_TASK_ID_SHOULD_NOT_APPEAR",
				sessionFile: "RAW_SESSION_FILE_SHOULD_NOT_APPEAR",
				createdAt: now + 1,
			},
		],
		latestVerification: null,
		taskAttemptCheckpoints: [],
		worldModel: [],
		policyGuidance: {
			missionId: "mission-1",
			verifiedOutcomeCount: 0,
			recommendedAgents: [],
			retryPolicy: "standard",
			laneMix: [],
			rationale: [],
		},
		rollbacks: [],
		researchRun: null,
		evidenceCards: Array.from({ length: 7 }, (_, index) => ({
			id: `ev-${index + 1}`,
			briefId: "brief-1",
			lane: "repo" as const,
			grade: "A" as const,
			sourceRef: `RAW_SOURCE_${index + 1}_SHOULD_NOT_APPEAR`,
			excerpt: `RAW_EXCERPT_${index + 1}_SHOULD_NOT_APPEAR`,
			claims: [`claim-${index + 1}`],
			capturedAt: now + index,
			directness: 1,
			specificity: 1,
			recency: 1,
			reproducibility: 1,
		})),
		latestSynthesis: {
			id: "syn-1",
			briefId: "brief-1",
			hypothesisCount: 1,
			recommended: "RAW_RECOMMENDED_SHOULD_NOT_APPEAR",
			summary: "RAW_SYNTHESIS_SUMMARY_SHOULD_NOT_APPEAR",
			rawOutput: "RAW_SYNTHESIS_OUTPUT_SHOULD_NOT_APPEAR",
			createdAt: now,
		},
		latestCritique: {
			id: "crit-1",
			briefId: "brief-1",
			blockingCount: 2,
			softCount: 1,
			verdict: "reject",
			summary: "blocked by missing proof",
			rawOutput: "RAW_CRITIQUE_OUTPUT_SHOULD_NOT_APPEAR",
			findings: [],
			createdAt: now,
		},
		runtimeCriticChecks: [],
		uncertaintyMap: null,
		criticDialogue: [],
		inspectorTargets: [],
		preferredInspectorTarget: null,
	};
}

describe("active mission context packet", () => {
	test("excludes raw outputs and caps evidence detail", () => {
		const packet = buildActiveMissionPacket(missionView());
		const rendered = renderActiveMissionPacket(packet);

		expect(packet.evidenceClaims).toHaveLength(5);
		expect(packet.omitted.evidenceClaims).toBe(2);
		expect(packet.omitted.evidenceCards).toBe(2);
		expect(packet.activeContract?.scopeIncludes).toEqual(["a", "b", "c"]);
		expect(packet.activeContract?.successCriteria).toEqual(["one", "two", "three", "four", "five"]);
		expect(packet.nextActions).toEqual(["act-1", "act-2", "act-3", "act-4", "act-5"]);
		expect(rendered).toContain("claim-5");
		expect(rendered).not.toContain("claim-6");
		expect(JSON.stringify(packet)).not.toContain("RAW_");
		expect(rendered).not.toContain("RAW_");
	});
});
