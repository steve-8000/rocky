import { describe, expect, test } from "bun:test";
import {
	type Mission as CoreMission,
	MISSION_LIFECYCLE_STATES,
	type MissionLifecycleState,
} from "../../src/mission/core";
import type { ResearchCampaign as LegacyMission, MissionState } from "../../src/mission/types";

function legacyStateToLifecycle(state: MissionState): MissionLifecycleState | undefined {
	switch (state) {
		case "researching":
		case "critiquing":
		case "executing":
		case "verifying":
		case "completed":
		case "rolled_back":
		case "blocked":
		case "cancelled":
			return state;
		case "contracted":
			return "contracting";
		default:
			return undefined;
	}
}

function lifecycleToLegacyState(lifecycle: MissionLifecycleState): MissionState | undefined {
	switch (lifecycle) {
		case "researching":
		case "critiquing":
		case "executing":
		case "verifying":
		case "completed":
		case "rolled_back":
		case "blocked":
		case "cancelled":
			return lifecycle;
		case "contracting":
			return "contracted";
		default:
			return undefined;
	}
}

function legacyMissionToCorePartial(legacy: LegacyMission): Partial<CoreMission> {
	const partial: Partial<CoreMission> = {
		id: legacy.id,
		title: legacy.title,
		riskLevel: legacy.riskLevel,
		createdAt: legacy.createdAt,
		updatedAt: legacy.updatedAt,
	};
	const lifecycle = legacyStateToLifecycle(legacy.state);
	if (lifecycle !== undefined) partial.lifecycle = lifecycle;
	if (legacy.decisionId !== null) partial.decisionId = legacy.decisionId;
	return partial;
}

function coreMissionToLegacyPartial(core: CoreMission): Partial<LegacyMission> {
	const partial: Partial<LegacyMission> = {
		id: core.id,
		title: core.title,
		riskLevel: core.riskLevel,
		decisionId: core.decisionId ?? null,
		createdAt: core.createdAt,
		updatedAt: core.updatedAt,
	};
	const state = lifecycleToLegacyState(core.lifecycle);
	if (state !== undefined) partial.state = state;
	return partial;
}

function coreMission(overrides: Partial<CoreMission> = {}): CoreMission {
	return {
		id: "m1",
		title: "Refactor the widget",
		objective: "Make the widget faster",
		mode: "interactive",
		lifecycle: "executing",
		riskLevel: "medium",
		constraints: ["no api changes"],
		acceptanceCriteria: [{ id: "ac1", description: "tests pass", satisfied: false }],
		budget: { tokenBudget: 100_000, tokensUsed: 0 },
		contextBudget: { maxContextTokens: 50_000, contextTokensUsed: 0 },
		tasks: [],
		evidenceRefs: [],
		createdAt: 1,
		updatedAt: 2,
		revision: 1,
		...overrides,
	};
}

function legacyMission(overrides: Partial<LegacyMission> = {}): LegacyMission {
	return {
		id: "m1",
		title: "Refactor the widget",
		objectiveId: "obj-1",
		briefId: "brief-1",
		decisionId: "dec-1",
		riskLevel: "medium",
		state: "executing",
		confidence: "high",
		snapshotRef: null,
		createdAt: 1,
		updatedAt: 2,
		revision: 1,
		...overrides,
	};
}

describe("mission core type construction", () => {
	test("a core Mission can be constructed with all required fields", () => {
		const mission = coreMission();
		expect(mission.lifecycle).toBe("executing");
		expect(mission.budget.tokenBudget).toBe(100_000);
		expect(mission.acceptanceCriteria).toHaveLength(1);
		expect(MISSION_LIFECYCLE_STATES).toContain(mission.lifecycle);
	});

	test("lifecycle constant covers the documented states", () => {
		expect(MISSION_LIFECYCLE_STATES).toEqual([
			"created",
			"classified",
			"planning",
			"researching",
			"critiquing",
			"contracting",
			"executing",
			"verifying",
			"completed",
			"blocked",
			"cancelled",
			"rolled_back",
		]);
	});
});

describe("compat: state mappings", () => {
	test("legacyStateToLifecycle maps overlapping states", () => {
		expect(legacyStateToLifecycle("executing")).toBe("executing");
		expect(legacyStateToLifecycle("contracted")).toBe("contracting");
		expect(legacyStateToLifecycle("completed")).toBe("completed");
		expect(legacyStateToLifecycle("blocked")).toBe("blocked");
		expect(legacyStateToLifecycle("rolled_back")).toBe("rolled_back");
	});

	test("legacyStateToLifecycle returns undefined for non-corresponding states", () => {
		const noEquivalent: MissionState[] = ["drafting", "synthesizing", "deciding"];
		for (const s of noEquivalent) {
			expect(legacyStateToLifecycle(s)).toBeUndefined();
		}
	});

	test("lifecycleToLegacyState maps overlapping states", () => {
		expect(lifecycleToLegacyState("contracting")).toBe("contracted");
		expect(lifecycleToLegacyState("executing")).toBe("executing");
		expect(lifecycleToLegacyState("cancelled")).toBe("cancelled");
	});

	test("lifecycleToLegacyState returns undefined for core-only states", () => {
		expect(lifecycleToLegacyState("created")).toBeUndefined();
		expect(lifecycleToLegacyState("classified")).toBeUndefined();
		expect(lifecycleToLegacyState("planning")).toBeUndefined();
	});

	test("round-trips through the overlapping subset", () => {
		for (const state of ["researching", "critiquing", "executing", "verifying", "completed"] as const) {
			const lifecycle = legacyStateToLifecycle(state);
			expect(lifecycle).toBeDefined();
			if (lifecycle) expect(lifecycleToLegacyState(lifecycle)).toBe(state);
		}
	});
});

describe("compat: mission projections", () => {
	test("legacyMissionToCorePartial copies overlapping fields", () => {
		const partial = legacyMissionToCorePartial(legacyMission());
		expect(partial.id).toBe("m1");
		expect(partial.title).toBe("Refactor the widget");
		expect(partial.riskLevel).toBe("medium");
		expect(partial.lifecycle).toBe("executing");
		expect(partial.decisionId).toBe("dec-1");
		expect(partial.createdAt).toBe(1);
		// objective has no legacy equivalent and must be omitted.
		expect(partial.objective).toBeUndefined();
	});

	test("legacyMissionToCorePartial omits lifecycle for non-corresponding states", () => {
		const partial = legacyMissionToCorePartial(legacyMission({ state: "drafting" }));
		expect(partial.lifecycle).toBeUndefined();
	});

	test("legacyMissionToCorePartial drops a null decisionId", () => {
		const partial = legacyMissionToCorePartial(legacyMission({ decisionId: null }));
		expect(partial.decisionId).toBeUndefined();
	});

	test("coreMissionToLegacyPartial copies overlapping fields", () => {
		const partial = coreMissionToLegacyPartial(coreMission());
		expect(partial.id).toBe("m1");
		expect(partial.title).toBe("Refactor the widget");
		expect(partial.riskLevel).toBe("medium");
		expect(partial.state).toBe("executing");
		expect(partial.decisionId).toBe(null);
	});

	test("coreMissionToLegacyPartial maps a missing decisionId to null", () => {
		const partial = coreMissionToLegacyPartial(coreMission({ decisionId: "dec-9" }));
		expect(partial.decisionId).toBe("dec-9");
	});

	test("coreMissionToLegacyPartial omits state for core-only lifecycle", () => {
		const partial = coreMissionToLegacyPartial(coreMission({ lifecycle: "planning" }));
		expect(partial.state).toBeUndefined();
	});

	test("does not mutate its input", () => {
		const legacy = legacyMission();
		const snapshot = JSON.stringify(legacy);
		legacyMissionToCorePartial(legacy);
		expect(JSON.stringify(legacy)).toBe(snapshot);
	});
});
