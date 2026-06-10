import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionStore } from "../../src/mission/store";
import { MissionControlView } from "../../src/modes/components/mission-control-view";
import { ResearchStore } from "../../src/research/store";

const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const item of cleanup.splice(0).reverse()) {
		item();
	}
});

function tempDb(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-control-view-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return path.join(root, "autonomy.db");
}

describe("MissionControlView", () => {
	test("renders panelized mission summary with lanes and evidence", () => {
		const dbPath = tempDb();
		const research = new ResearchStore(dbPath);
		const brief = research.createBrief({
			id: "brief-1",
			objectiveId: "objective-1",
			question: "Improve mission control",
			lanes: ["repo"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "medium",
			stopCriteria: [],
		});
		research.addEvidence({
			id: "ev-1",
			briefId: brief.id,
			lane: "repo",
			grade: "A",
			sourceRef: "src/file.ts:1",
			excerpt: "mission evidence",
			claims: ["claim"],
			directness: 1,
			specificity: 1,
			recency: 1,
			reproducibility: 1,
		});
		const decision = research.recordDecision({
			id: "decision-1",
			briefId: brief.id,
			hypothesis: "Ship the compact panel",
			rationale: "Evidence supports it",
			kind: "select",
			confidence: "high",
			evidenceRefs: ["ev-1"],
			rejectedOptions: [{ id: "dense-overlay", reason: "Too heavy for compact view" }],
			nextActions: ["Check Mission Control render"],
		});
		const missions = new MissionStore(dbPath);
		const mission = missions.listMissions({ briefId: brief.id })[0];
		missions.updateMission(mission.id, { state: "verifying", confidence: "high", decisionId: decision.id });
		missions.createLaneRun({
			id: "lane-1",
			missionId: mission.id,
			lane: "repo",
			agent: "Explore",
			epistemicRole: "repo_truth",
			status: "completed",
			evidenceCount: 1,
			emptyReason: null,
			taskId: null,
			startedAt: 1,
			endedAt: 2,
		});
		cleanup.push(
			() => missions.close(),
			() => research.close(),
		);

		const view = new MissionControlView({ dbPath, initialMode: "compact" });
		cleanup.push(() => view.dispose());
		const rendered = Bun.stripANSI(view.render(100).join("\n"));

		expect(rendered).toContain("Mission Control");
		expect(rendered).toContain("Objective: Improve mission control");
		expect(rendered).toContain("State: verifying | confidence high | risk medium");
		expect(rendered).toContain("Research run: <none>");
		expect(rendered).toContain("Snapshot: unavailable");
		expect(rendered).toContain("── Orchestration ──");
		expect(rendered).toContain("[repo truth] Explore | repo | completed | evidence 1");
		expect(rendered).toContain("── Evidence Board ──");
		expect(rendered).toContain("[repo] ev-1 | grade A | src/file.ts:1");
		// P9.2: empty Synthesis / Critique section is suppressed in compact mode.
		expect(rendered).not.toContain("── Synthesis / Critique ──");
		expect(rendered).toContain("── Decision Contract ──");
		expect(rendered).toContain("Decision: select | high | Ship the compact panel");
		expect(rendered).toContain("Evidence refs: ev-1 | rejected options 1 | next actions 1");
		expect(rendered).toContain("Execution contract: <none>");
		// P9.2: empty Verification / Rollback section is suppressed in compact mode.
		expect(rendered).not.toContain("── Verification / Rollback ──");
		expect(rendered).toContain("Mission Inspector: Ctrl+S for tool traces, artifacts, and subagent details");
	});

	test("selects missions predictably and renders multi-mission strip", () => {
		const dbPath = tempDb();
		const research = new ResearchStore(dbPath);
		research.createBrief({
			id: "brief-first",
			objectiveId: "objective-first",
			question: "First mission",
			lanes: ["repo"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "low",
			stopCriteria: [],
		});
		research.createBrief({
			id: "brief-second",
			objectiveId: "objective-second",
			question: "Second mission",
			lanes: ["source"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "medium",
			stopCriteria: [],
		});
		const missions = new MissionStore(dbPath);
		cleanup.push(
			() => missions.close(),
			() => research.close(),
		);

		const view = new MissionControlView({
			dbPath,
			initialMode: "compact",
			getPreferredMissionInput: () => ({ title: "First mission" }),
		});
		cleanup.push(() => view.dispose());

		let rendered = Bun.stripANSI(view.render(120).join("\n"));
		expect(rendered).toContain("Missions: 2 total | selected 2/2 | First mission");
		expect(rendered).toContain("Objective: First mission");
		expect(view.selectNextMission()).toBe(true);
		rendered = Bun.stripANSI(view.render(120).join("\n"));
		expect(rendered).toContain("Missions: 2 total | selected 1/2 | Second mission");
		expect(rendered).toContain("Objective: Second mission");
		expect(view.selectPreviousMission()).toBe(true);
		rendered = Bun.stripANSI(view.render(120).join("\n"));
		expect(rendered).toContain("Missions: 2 total | selected 2/2 | First mission");
	});

	test("renders synthesis critique decision contract and rollback details", () => {
		const dbPath = tempDb();
		const research = new ResearchStore(dbPath);
		const brief = research.createBrief({
			id: "brief-rich",
			objectiveId: "objective-rich",
			question: "Panelize mission control",
			lanes: ["repo", "source"],
			requiredEvidence: [],
			disallowedEvidence: [],
			riskLevel: "high",
			stopCriteria: [],
		});
		research.addEvidence({
			id: "ev-rich-1",
			briefId: brief.id,
			lane: "source",
			grade: "B",
			sourceRef: "docs/ux.md:10",
			excerpt: "panel evidence",
			claims: ["panel claim"],
			directness: 1,
			specificity: 1,
			recency: 1,
			reproducibility: 1,
			capturedAt: 10,
		});
		research.recordSynthesis({
			id: "syn-rich",
			briefId: brief.id,
			hypothesisCount: 2,
			recommended: "Panelized console",
			summary: "Use separated operational panels",
			rawOutput: "raw synthesis",
			createdAt: 20,
		});
		research.recordCritique({
			id: "crit-rich",
			briefId: brief.id,
			blockingCount: 1,
			softCount: 2,
			verdict: "accept-with-modifications",
			summary: "Keep inspector visible",
			rawOutput: "raw critique",
			createdAt: 30,
		});
		const decision = research.recordDecision({
			id: "decision-rich",
			briefId: brief.id,
			hypothesis: "Adopt panelized text console",
			rationale: "Evidence supports it",
			kind: "select",
			confidence: "medium",
			evidenceRefs: ["ev-rich-1"],
			rejectedOptions: [{ id: "modal-only", reason: "Hides inline mission state" }],
			nextActions: ["Run focused view test", "Inspect linked trace"],
		});
		const missions = new MissionStore(dbPath);
		const mission = missions.listMissions({ briefId: brief.id })[0];
		missions.updateMission(mission.id, {
			state: "verifying",
			confidence: "medium",
			decisionId: decision.id,
			snapshotRef: "snapshot-rich",
		});
		missions.createResearchRun({
			id: "run-rich",
			missionId: mission.id,
			briefId: brief.id,
			objectiveId: "objective-rich",
			status: "completed",
			startedAt: 1,
			completedAt: 2,
		});
		missions.recordContract({
			id: "contract-rich",
			missionId: mission.id,
			role: "mission-control-panelizer",
			parentMissionRev: 1,
			include: ["packages/coding-agent/src/modes/components/mission-control-view.ts"],
			exclude: ["docs/**"],
			successCriteria: ["checkts", "panel-tests"],
			escalation: { onUncertainty: "ask-parent", budgetCap: 1200 },
			inputArtifact: null,
			mustProduce: ["changed files"],
			taskId: "contract-task",
			sessionFile: "/tmp/contract-task.jsonl",
			createdAt: 40,
		});
		missions.createLaneRun({
			id: "lane-rich",
			missionId: mission.id,
			lane: "repo",
			agent: "Explore",
			epistemicRole: "repo_truth",
			status: "completed",
			evidenceCount: 1,
			emptyReason: null,
			taskId: "lane-task",
			startedAt: 3,
			endedAt: 4,
		});
		missions.recordVerification({
			id: "verification-rich",
			missionId: mission.id,
			status: "fail",
			failedCount: 1,
			uncertainCount: 0,
			summary: "one assertion failed",
			createdAt: 50,
		});
		missions.recordCriticDialogueExchange({
			missionId: mission.id,
			orchestratorSummary: "plan gate requested",
			criticSummary: "missing repo evidence",
			checkIds: ["runtime-critic:brief-rich:missing-lane-evidence:repo"],
			blockingCheckIds: ["runtime-critic:brief-rich:missing-lane-evidence:repo"],
			createdAt: 55,
		});
		missions.recordRollback({
			id: "rollback-rich",
			missionId: mission.id,
			targetType: "decision",
			targetId: decision.id,
			snapshotRef: "snapshot-rich",
			summary: "restore prior decision",
			createdAt: 60,
		});
		cleanup.push(
			() => missions.close(),
			() => research.close(),
		);

		const view = new MissionControlView({ dbPath, initialMode: "compact" });
		cleanup.push(() => view.dispose());
		let rendered = Bun.stripANSI(view.render(140).join("\n"));

		expect(rendered).toContain("Research run: completed (run-rich)");
		expect(rendered).toContain("Snapshot: available");
		expect(rendered).toContain("[source] ev-rich-1 | grade B | docs/ux.md:10");
		expect(rendered).not.toContain("panel evidence");
		expect(rendered).not.toContain("── Inspector Targets ──");
		expect(rendered).toContain(
			"Synthesis: Use separated operational panels | hypotheses 2 | recommended Panelized console",
		);
		expect(rendered).toContain(
			"Critique: accept-with-modifications | blockers 1 | soft concerns 2 | Keep inspector visible",
		);
		expect(rendered).toContain("── Runtime Critic ──");
		expect(rendered).toContain("Checks: 4 total | blocked 2 | soft 2");
		expect(rendered).toContain("Dialogue: 2 turns | latest inner-critic: missing repo evidence");
		expect(rendered).toContain("Decision: select | medium | Adopt panelized text console");
		expect(rendered).toContain("Evidence refs: ev-rich-1 | rejected options 1 | next actions 2");
		expect(rendered).toContain("Next actions (2): Run focused view test, Inspect linked trace");
		expect(rendered).toContain(
			"Execution contract: mission-control-panelizer | scope +1/-1 | criteria 2 | outputs 1",
		);
		expect(rendered).toContain("Linked trace: contract:contract-task");
		expect(rendered).toContain("Mission Inspector: Ctrl+S opens linked contract trace first");
		expect(view.getPreferredInspectorTarget()).toEqual({
			sessionId: "contract-task",
			sessionFile: "/tmp/contract-task.jsonl",
		});
		expect(view.getDisplayMode()).toBe("compact");
		expect(view.toggleDisplayMode()).toBe("expanded");
		expect(view.getDisplayMode()).toBe("expanded");
		rendered = Bun.stripANSI(view.render(180).join("\n"));
		expect(rendered).toContain("[source] ev-rich-1 | grade B | docs/ux.md:10 | claims panel claim | panel evidence");
		expect(rendered).toContain("Rejected modal-only: Hides inline mission state");
		expect(rendered).toContain("Outputs: changed files");
		expect(rendered).toContain("Criteria: checkts, panel-tests");
		expect(rendered).toContain("── Inspector Targets ──");
		expect(rendered).toContain(
			"1. contract:contract-task | preferred | source contract | file /tmp/contract-task.jsonl",
		);
		expect(rendered).toContain("2. lane:lane-task | available | source lane-run");
		expect(rendered).toContain("Verification: fail | failed 1 | uncertain 0 | one assertion failed");
		expect(rendered).toContain("Rollback: restore prior decision | snapshots 1");
	});

	test("renders empty state when no mission exists", () => {
		const dbPath = tempDb();
		const view = new MissionControlView({ dbPath, initialMode: "compact" });
		cleanup.push(() => view.dispose());

		const rendered = Bun.stripANSI(view.render(100).join("\n"));

		expect(rendered).toContain("Mission Control");
		expect(rendered).toContain("No active mission yet.");
		expect(rendered).toContain("Mission Inspector: Ctrl+S for tool traces, artifacts, and subagent details");
	});

	test("defaults to off — renders nothing on the terminal surface", () => {
		const dbPath = tempDb();
		const view = new MissionControlView({ dbPath });
		cleanup.push(() => view.dispose());

		// Default surface is off: no box, no lines — terminal stays lean/tool-centric.
		expect(view.getDisplayMode()).toBe("off");
		expect(view.render(100)).toEqual([]);
	});

	test("toggle cycles off -> compact -> expanded -> off", () => {
		const dbPath = tempDb();
		const view = new MissionControlView({ dbPath });
		cleanup.push(() => view.dispose());

		expect(view.getDisplayMode()).toBe("off");
		expect(view.toggleDisplayMode()).toBe("compact");
		expect(view.render(100).length).toBeGreaterThan(0);
		expect(view.toggleDisplayMode()).toBe("expanded");
		expect(view.toggleDisplayMode()).toBe("off");
		expect(view.render(100)).toEqual([]);
	});
});
