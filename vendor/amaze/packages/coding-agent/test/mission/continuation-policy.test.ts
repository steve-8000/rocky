import { describe, expect, test } from "bun:test";
import {
	buildAcceptancePreflight,
	classifyContinuation,
	progressFingerprint,
} from "../../src/mission/continuation/policy";
import type { MissionContinuationRecord } from "../../src/mission/continuation/types";
import type { Mission, MissionLifecycleState } from "../../src/mission/core/mission";
import type { MissionIntent } from "../../src/mission/policy/intent";

function mission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "m1",
		title: "t",
		objective: "Ship feature X end to end",
		mode: "interactive",
		lifecycle: "executing",
		riskLevel: "medium",
		intent: "code_change",
		constraints: [],
		acceptanceCriteria: [],
		budget: { tokenBudget: 0, tokensUsed: 0 },
		contextBudget: { maxContextTokens: 0, contextTokensUsed: 0 },
		tasks: [],
		evidenceRefs: [],
		createdAt: 0,
		updatedAt: 0,
		revision: 0,
		...overrides,
	};
}

function record(overrides: Partial<MissionContinuationRecord> = {}): MissionContinuationRecord {
	return {
		missionId: "m1",
		sessionId: null,
		ownerBranch: null,
		ownerTreeId: null,
		status: "idle",
		generation: 0,
		autoTurnCount: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		progressFingerprint: null,
		noProgressCount: 0,
		lastReason: null,
		lastScheduledAt: null,
		lastStartedAt: null,
		lastEndedAt: null,
		lastTurnId: null,
		updatedAt: 0,
		...overrides,
	};
}

const baseInput = {
	record: record(),
	hasPendingUserMessage: false,
	needsProposal: false,
	maxAutoTurns: 50,
	noProgressLimit: 3,
};

describe("buildAcceptancePreflight", () => {
	test("code_change with passing verification and no phases passes", () => {
		const pf = buildAcceptancePreflight(
			mission({ verification: { status: "pass", verdict: "pass", summary: "ok" } }),
		);
		expect(pf.passes).toBe(true);
		expect(pf.missingGates).toEqual([]);
	});

	test("runtime_refactor missing decision + regression + verification surfaces all gates", () => {
		const pf = buildAcceptancePreflight(mission({ intent: "runtime_refactor" as MissionIntent }));
		expect(pf.passes).toBe(false);
		expect(pf.missingGates).toEqual([
			"decisionId",
			"regressionContractId",
			"verification.verdict=pass",
			"review.verdict=pass",
		]);
	});

	test("unverified phases block completion", () => {
		const pf = buildAcceptancePreflight(
			mission({
				verification: { status: "pass", verdict: "pass", summary: "ok" },
				phases: [
					{ id: "p1", name: "Phase 1", status: "verified" },
					{ id: "p2", name: "Phase 2", status: "pending" },
				] as NonNullable<Mission["phases"]>,
			}),
		);
		expect(pf.passes).toBe(false);
		expect(pf.unverifiedPhases).toEqual(["Phase 2"]);
	});

	test("recorded failing verdict is a failing verdict, not a missing gate", () => {
		const pf = buildAcceptancePreflight(
			mission({ verification: { status: "fail", verdict: "fail", summary: "bad" } }),
		);
		expect(pf.failingVerdict).toBe(true);
		expect(pf.passes).toBe(false);
	});
});

describe("classifyContinuation", () => {
	test("no mission → none", () => {
		const action = classifyContinuation({ ...baseInput, mission: undefined });
		expect(action.kind).toBe("none");
	});

	for (const lifecycle of ["completed", "blocked", "cancelled", "rolled_back"] as MissionLifecycleState[]) {
		test(`terminal lifecycle ${lifecycle} → observe-terminal (never schedules)`, () => {
			const action = classifyContinuation({ ...baseInput, mission: mission({ lifecycle }) });
			expect(action.kind).toBe("observe-terminal");
		});
	}

	test("pending user message → hold (user intent priority)", () => {
		const action = classifyContinuation({ ...baseInput, mission: mission(), hasPendingUserMessage: true });
		expect(action).toEqual({ kind: "hold", status: "idle", reason: "user_message_pending" });
	});

	test("auto mode mission is not eligible for hidden continuation", () => {
		const action = classifyContinuation({ ...baseInput, mission: mission({ mode: "auto" }) });
		expect(action).toEqual({ kind: "none", reason: "auto_mission_not_continuable" });
	});

	test("paused ledger → hold paused", () => {
		const action = classifyContinuation({
			...baseInput,
			mission: mission(),
			record: record({ status: "paused" }),
		});
		expect(action).toEqual({ kind: "hold", status: "paused", reason: "continuation_paused" });
	});

	test("needs proposal → hold awaiting approval", () => {
		const action = classifyContinuation({ ...baseInput, mission: mission(), needsProposal: true });
		expect(action).toEqual({ kind: "hold", status: "idle", reason: "awaiting_proposal_approval" });
	});

	test("max auto turns reached → hold budget_limited", () => {
		const action = classifyContinuation({
			...baseInput,
			mission: mission(),
			record: record({ autoTurnCount: 50 }),
			maxAutoTurns: 50,
		});
		expect(action).toEqual({ kind: "hold", status: "budget_limited", reason: "max_auto_turns" });
	});

	test("no-progress limit reached → hold paused", () => {
		const action = classifyContinuation({
			...baseInput,
			mission: mission(),
			record: record({ noProgressCount: 3 }),
			noProgressLimit: 3,
		});
		expect(action).toEqual({ kind: "hold", status: "paused", reason: "no_progress_limit" });
	});

	test("executing incomplete mission → continue (missing_requirements)", () => {
		const action = classifyContinuation({ ...baseInput, mission: mission({ intent: "runtime_refactor" }) });
		expect(action).toEqual({ kind: "continue", reason: "missing_requirements" });
	});

	test("acceptance passes but no outcome → continue to record completion", () => {
		const action = classifyContinuation({
			...baseInput,
			mission: mission({ verification: { status: "pass", verdict: "pass", summary: "ok" } }),
		});
		expect(action).toEqual({ kind: "continue", reason: "record_completion" });
	});

	test("acceptance passes and outcome recorded → none", () => {
		const action = classifyContinuation({
			...baseInput,
			mission: mission({
				verification: { status: "pass", verdict: "pass", summary: "ok" },
				outcome: { status: "success", summary: "done", recordedAt: 1 },
			}),
		});
		expect(action.kind).toBe("none");
	});
});

describe("progressFingerprint", () => {
	test("is stable for identical observable state", () => {
		const m = mission();
		expect(progressFingerprint(m)).toBe(progressFingerprint(mission()));
	});

	test("changes when lifecycle or evidence changes but not when updatedAt changes", () => {
		const a = mission({ updatedAt: 1 });
		const b = mission({ updatedAt: 999_999 });
		expect(progressFingerprint(a)).toBe(progressFingerprint(b));
		const c = mission({ evidenceRefs: ["e1"] });
		expect(progressFingerprint(a)).not.toBe(progressFingerprint(c));
	});
});
