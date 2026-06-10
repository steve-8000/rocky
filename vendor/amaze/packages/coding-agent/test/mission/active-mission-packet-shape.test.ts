import { describe, expect, test } from "bun:test";
import { buildActiveMissionPacket, renderActiveMissionPacket } from "../../src/mission/context-packet";
import type { Mission } from "../../src/mission/core";
import type { MissionIntent } from "../../src/mission/policy/intent";

type MissionLike = Mission & {
	state: "executing";
	objectiveId: string | null;
	briefId: string | null;
	confidence: "high" | "medium" | "low" | null;
	decisionId: string | null;
	snapshotRef: string | null;
};

const intents: MissionIntent[] = [
	"conversation",
	"question_answering",
	"repo_exploration",
	"code_change",
	"architecture_change",
	"runtime_refactor",
	"release_hardening",
	"external_side_effect",
];

function mission(intent: MissionIntent, taskCount = 5): MissionLike {
	return {
		id: `mission-${intent}`,
		title: `Handle ${intent.replaceAll("_", " ")}`,
		objective: `Complete bounded ${intent.replaceAll("_", " ")} work with clear acceptance.`,
		mode: "interactive",
		lifecycle: "executing",
		state: "executing",
		riskLevel: intent === "external_side_effect" ? "high" : "medium",
		intent,
		objectiveId: `objective-${intent}`,
		briefId: null,
		constraints: ["preserve public behavior"],
		confidence: "medium",
		snapshotRef: null,
		acceptanceCriteria: [{ id: "ac-1", description: "Observable behavior is verified", satisfied: false }],
		budget: { tokenBudget: 100_000, tokensUsed: 1200 },
		contextBudget: { maxContextTokens: 20_000, contextTokensUsed: 800 },
		plan: { steps: [{ id: "step-1", description: "Apply the focused change" }] },
		tasks: Array.from({ length: taskCount }, (_, index) => ({
			id: `task-${index + 1}`,
			title: `Bounded task ${index + 1}`,
			status: index === 0 ? "running" : "pending",
		})),
		evidenceRefs: ["evidence-1"],
		decisionId: `dec-${intent}`,
		regressionContractId: `rc-${intent}`,
		verification: { status: "uncertain", verdict: "pending", summary: "Verification not complete." },
		createdAt: 1,
		updatedAt: 2,
		revision: 1,
	};
}

function packetFor(missionValue: MissionLike) {
	return buildActiveMissionPacket({
		mission: missionValue,
		brief: null,
		decision: null,
		evidenceCount: 0,
		evidenceByLane: [],
		laneRuns: [],
		objective: null,
		decisionSummary: null,
		proposals: [],
		contracts: [],
		latestVerification: null,
		taskAttemptCheckpoints: [],
		rollbacks: [],
		researchRun: null,
		worldModel: [],
		policyGuidance: {
			missionId: missionValue.id,
			verifiedOutcomeCount: 0,
			recommendedAgents: [],
			retryPolicy: "standard",
			laneMix: [],
			rationale: [],
		},
		evidenceCards: [],
		latestSynthesis: null,
		latestCritique: null,
		runtimeCriticChecks: [],
		uncertaintyMap: null,
		criticDialogue: [],
		inspectorTargets: [],
		preferredInspectorTarget: null,
	});
}

// Rough proxy: actual tokenizer-derived counts should be similar for these compact packets.
function tokens(rendered: string): number {
	return Math.ceil(rendered.length / 4);
}

function percentile95(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

describe("active mission packet shape", () => {
	test("keeps pointer packet token proxy under the guard threshold", () => {
		const counts = intents.map(intent => tokens(renderActiveMissionPacket(packetFor(mission(intent)))));

		for (const count of counts) {
			expect(count).toBeLessThanOrEqual(250);
		}
		expect(percentile95(counts)).toBeLessThanOrEqual(250);
	});

	test("stays effectively constant size as mission task count grows", () => {
		const fiveTaskLength = renderActiveMissionPacket(packetFor(mission("code_change", 5))).length;
		const fiftyTaskLength = renderActiveMissionPacket(packetFor(mission("code_change", 50))).length;

		expect(fiftyTaskLength).toBeLessThanOrEqual(Math.ceil(fiveTaskLength * 1.1));
	});
});
