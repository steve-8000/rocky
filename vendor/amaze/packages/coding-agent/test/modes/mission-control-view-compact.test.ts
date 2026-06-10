import { describe, expect, test } from "bun:test";
import { buildMissionControlLines } from "../../src/modes/components/mission-control-view";

// Minimal MissionView fixture — only fields the renderer reads. Kept inline so it doesn't drift
// with unrelated MissionView field additions in unrelated callers.
function viewWithObjective(objective: string) {
	return {
		mission: {
			id: "mission-1",
			title: objective,
			objectiveId: null,
			briefId: null,
			decisionId: null,
			riskLevel: "medium",
			state: "drafting",
			confidence: null,
			snapshotRef: null,
			createdAt: 1,
			updatedAt: 1,
		},
		objective: { id: "objective-1", title: objective },
		laneRuns: [],
		evidenceCards: [],
		criticDialogue: [],
		researchRun: null,
		latestSynthesis: null,
		latestCritique: null,
		decision: null,
		decisionSummary: null,
		contracts: [],
		runtimeCriticChecks: [],
		rollbacks: [],
		latestVerification: null,
		inspectorTargets: [],
		preferredInspectorTarget: null,
	} as never;
}

describe("Mission Control compact layout", () => {
	test("compact mode hides empty Orchestration/Evidence/Synthesis sections", () => {
		const lines = buildMissionControlLines(viewWithObjective("Short obj"), { mode: "compact" });
		const output = lines.join("\n");

		expect(output).not.toContain("── Orchestration ──");
		expect(output).not.toContain("── Evidence Board ──");
		expect(output).not.toContain("── Synthesis / Critique ──");
		expect(output).toContain("Mission Control — ");
		expect(output).toContain("Mission Inspector: Ctrl+S for tool traces, artifacts, and subagent details");
	});

	test("expanded mode still shows empty sections", () => {
		const lines = buildMissionControlLines(viewWithObjective("Short obj"), { mode: "expanded" });
		const output = lines.join("\n");

		expect(output).toContain("── Orchestration ──");
		expect(output).toContain("── Evidence Board ──");
	});

	test("compact mode shows a section once it has content", () => {
		const view = viewWithObjective("Short obj") as any;
		view.laneRuns = [
			{
				lane: "source",
				status: "running",
				agent: "Explore",
				epistemicRole: "for",
				evidenceCount: 1,
				emptyReason: null,
				taskId: "task-1",
				startedAt: 1,
				endedAt: null,
			},
		];

		const lines = buildMissionControlLines(view, { mode: "compact" });

		expect(lines.join("\n")).toContain("── Orchestration ──");
	});

	test("compact mode total row count is at most 9 for an empty mission", () => {
		const lines = buildMissionControlLines(viewWithObjective("Short obj"), { mode: "compact" });

		expect(lines.length).toBeLessThanOrEqual(9);
	});
});
