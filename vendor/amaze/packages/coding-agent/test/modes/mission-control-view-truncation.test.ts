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
	} as never;
}

describe("Mission Control header truncation (P9)", () => {
	test("collapses a multi-line markdown objective into a single header line", () => {
		const objective =
			"# Amaze 전체 개선 개발계획\n\n## 목표\n\n```text\nGoal 완전 제거\nMission 단일 runtime kernel화\n```";
		const lines = buildMissionControlLines(viewWithObjective(objective), { mode: "compact" });

		const header = lines[0];
		expect(header).toMatch(/^Mission Control — /);
		expect(header).not.toInclude("\n");
		// Header is one logical line; original objective is many. Cap is 60 chars after the prefix.
		const label = header.replace("Mission Control — ", "");
		expect(label.length).toBeLessThanOrEqual(60);
		// First-line content is preserved (it's the markdown heading).
		expect(label).toInclude("Amaze");

		// Objective row also one line and capped at 96.
		const objectiveRow = lines.find(l => l.startsWith("Objective: "));
		expect(objectiveRow).toBeDefined();
		expect(objectiveRow).not.toInclude("\n");
	});

	test("preserves a short objective verbatim", () => {
		const lines = buildMissionControlLines(viewWithObjective("Ship the release"), { mode: "compact" });
		expect(lines[0]).toBe("Mission Control — Ship the release");
		expect(lines.find(l => l.startsWith("Objective: "))).toBe("Objective: Ship the release");
	});

	test("trims trailing whitespace before truncation", () => {
		const objective = "   leading and trailing whitespace   \n\nother stuff";
		const lines = buildMissionControlLines(viewWithObjective(objective), { mode: "compact" });
		expect(lines[0]).toBe("Mission Control — leading and trailing whitespace");
	});

	test("falls back to placeholder for an empty title", () => {
		const lines = buildMissionControlLines(viewWithObjective(""), { mode: "compact" });
		expect(lines[0]).toBe("Mission Control — (no title)");
	});
});
