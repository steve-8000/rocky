import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObjectiveStore } from "../../src/autonomy/store";
import {
	runMissionEvidenceCommand,
	runMissionRollbackCommand,
	runMissionShowCommand,
	runMissionVerifyCommand,
} from "../../src/cli/mission";
import { MissionReadModel } from "../../src/mission/read-model";
import { MissionStore } from "../../src/mission/store";
import { buildMissionControlLines } from "../../src/modes/components/mission-control-view";
import { ResearchStore } from "../../src/research/store";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true });
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	let stdout = "";
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return stdout;
}

describe("mission control dogfood", () => {
	test("read model, CLI, and MissionControlView reflect final mission state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-dogfood-"));
		roots.push(root);
		const dbPath = path.join(root, "autonomy.db");
		const objectives = new ObjectiveStore(dbPath);
		const research = new ResearchStore(dbPath);
		const missions = new MissionStore(dbPath);
		const readModel = new MissionReadModel({ dbPath });
		try {
			const objective = objectives.create({
				title: "Dogfood Mission Control closure",
				metricTargets: [],
				budget: {},
				guardrails: {},
			});
			const brief = research.createBrief({
				objectiveId: objective.id,
				question: "Can Mission Control close Wave8?",
				lanes: ["repo", "source", "social"],
				requiredEvidence: [],
				disallowedEvidence: [],
				riskLevel: "medium",
				stopCriteria: [],
			});
			const mission = missions.listMissions({ briefId: brief.id })[0];
			expect(mission).toBeDefined();

			const repoEvidence = research.addEvidence({
				briefId: brief.id,
				lane: "repo",
				grade: "A",
				sourceRef: "packages/coding-agent/src/cli/mission.ts:1",
				excerpt: "Mission CLI evidence exists",
				claims: ["mission filters exists and is implemented"],
				directness: 1,
				specificity: 1,
				recency: 1,
				reproducibility: 1,
			});
			const speculativeEvidence = research.addEvidence({
				briefId: brief.id,
				lane: "source",
				grade: "B",
				sourceRef: "docs/agi.md:12",
				excerpt: "Speculative exploratory future note",
				claims: ["mission future is exploratory"],
				directness: 0.8,
				specificity: 0.8,
				recency: 1,
				reproducibility: 0.7,
			});
			const conflictingEvidence = research.addEvidence({
				briefId: brief.id,
				lane: "social",
				grade: "C",
				sourceRef: "social://mission",
				excerpt: "Prior contradicts repo",
				claims: ["mission filters missing and not implemented"],
				directness: 0.6,
				specificity: 0.7,
				recency: 1,
				reproducibility: 0.6,
			});
			const decision = research.recordDecision({
				briefId: brief.id,
				hypothesis: "Ship Mission Control Wave8",
				rationale: "Repo truth and operator surfaces are present with known speculative/conflicting annotations.",
				kind: "select",
				confidence: "high",
				evidenceRefs: [repoEvidence.id, speculativeEvidence.id, conflictingEvidence.id],
				rejectedOptions: [],
				nextActions: ["monitor dogfood output"],
			});
			missions.updateMission(mission.id, {
				state: "completed",
				confidence: "high",
				decisionId: decision.id,
				snapshotRef: "snapshot-dogfood-1",
			});
			missions.createLaneRun({
				missionId: mission.id,
				lane: "repo",
				agent: "Explore",
				epistemicRole: "repo_truth",
				status: "completed",
				evidenceCount: 1,
				emptyReason: null,
				taskId: "task-repo",
				startedAt: 1,
				endedAt: 2,
			});
			missions.createLaneRun({
				missionId: mission.id,
				lane: "source",
				agent: "Resercher",
				epistemicRole: "source_harvest",
				status: "completed",
				evidenceCount: 1,
				emptyReason: null,
				taskId: "task-source",
				startedAt: 1,
				endedAt: 2,
			});
			missions.recordContract({
				missionId: mission.id,
				role: "dogfood-worker",
				parentMissionRev: 1,
				include: ["packages/coding-agent/**"],
				exclude: [],
				successCriteria: ["wave8 dogfood passes"],
				escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
				inputArtifact: null,
				mustProduce: ["verification"],
				createdAt: 10,
			});
			missions.recordVerification({
				missionId: mission.id,
				status: "pass",
				failedCount: 0,
				uncertainCount: 0,
				summary: "dogfood passed",
				createdAt: 20,
			});
			missions.recordRollback({
				id: "rollback-dogfood-1",
				missionId: mission.id,
				targetType: "decision",
				targetId: decision.id,
				snapshotRef: "snapshot-dogfood-1",
				summary: "restore pre-decision state",
				createdAt: 30,
			});

			const view = readModel.getMissionView(mission.id);
			expect(view).toBeDefined();
			expect(view?.decisionSummary?.id).toBe(decision.id);
			expect(view?.contracts).toHaveLength(1);
			expect(view?.latestVerification?.status).toBe("pass");
			expect(view?.rollbacks).toHaveLength(1);

			const showStdout = await captureStdout(() => runMissionShowCommand({ db: dbPath, id: mission.id }));
			expect(showStdout).toContain("Verification: pass");
			expect(showStdout).toContain("Rollbacks: 1");
			expect(showStdout).toContain("[repo truth] repo_truth");

			const evidenceStdout = await captureStdout(() => runMissionEvidenceCommand({ db: dbPath, id: mission.id }));
			expect(evidenceStdout).toContain(`${repoEvidence.id} [conflicting]`);
			expect(evidenceStdout).toContain(`${speculativeEvidence.id} [speculative]`);
			expect(evidenceStdout).toContain(`${conflictingEvidence.id} [conflicting]`);
			const filteredEvidenceStdout = await captureStdout(() =>
				runMissionEvidenceCommand({ db: dbPath, id: mission.id, status: "speculative", query: "future" }),
			);
			expect(filteredEvidenceStdout).toContain(speculativeEvidence.id);
			expect(filteredEvidenceStdout).not.toContain(repoEvidence.id);

			const verifyStdout = await captureStdout(() => runMissionVerifyCommand({ db: dbPath, id: mission.id }));
			expect(verifyStdout).toContain("verification: pass failed=0 uncertain=0 dogfood passed");
			const rollbackStdout = await captureStdout(() => runMissionRollbackCommand({ db: dbPath, id: mission.id }));
			expect(rollbackStdout).toContain("rollback-dogfood-1  decision:");
			expect(rollbackStdout).toContain("Snapshot: snapshot-dogfood-1");

			const controlLines = buildMissionControlLines(view!).join("\n");
			expect(controlLines).toContain("Verification: pass | failed 0 | uncertain 0 | dogfood passed");
			expect(controlLines).toContain("Rollback: restore pre-decision state | snapshots 1");
			expect(controlLines).toContain("[repo truth] Explore | repo | completed | evidence 1");
			expect(controlLines).toContain("[source] Resercher | source | completed | evidence 1");
		} finally {
			readModel.close();
			missions.close();
			research.close();
			objectives.close();
		}
	});
});
