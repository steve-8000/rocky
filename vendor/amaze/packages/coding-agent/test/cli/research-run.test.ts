import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runResearchAddEvidenceCommand,
	runResearchBriefCommand,
	runResearchRecordCritiqueCommand,
	runResearchRecordSynthesisCommand,
	runResearchRunCommand,
} from "../../src/cli/research";
import { MissionReadModel } from "../../src/mission/read-model";
import { MissionStore } from "../../src/mission/store";

let cleanupRoot: string | undefined;

function testDb(): string {
	cleanupRoot = path.join(os.tmpdir(), `amaze-research-run-${Date.now()}-${Math.random()}`);
	return path.join(cleanupRoot, "research.db");
}

afterEach(() => {
	if (cleanupRoot) {
		fs.rmSync(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("research run CLI helper", () => {
	it("creates a research run and pending lane runs with lane mappings", async () => {
		const db = testDb();
		const brief = await createBrief(db, "Which lanes should run?", "repo,source,social");

		const stdout = await captureStdout(async () => {
			await runResearchRunCommand({ db, briefId: brief.id, json: true });
		});
		const output = JSON.parse(stdout);

		const missions = new MissionStore(db);
		try {
			const mission = missions.listMissions({ briefId: brief.id })[0];
			expect(output.missionId).toBe(mission.id);
			expect(output.lanes).toEqual(["repo", "source", "social"]);
			expect(output.laneRunIds).toHaveLength(3);
			expect(missions.getResearchRun(output.runId)).toMatchObject({
				missionId: mission.id,
				briefId: brief.id,
				objectiveId: null,
				status: "running",
				completedAt: null,
			});
			expect(missions.getMission(mission.id)?.state).toBe("researching");
			expect(missions.listLaneRuns(mission.id)).toMatchObject([
				{
					id: output.laneRunIds[0],
					lane: "repo",
					agent: "Explore",
					epistemicRole: "repo_truth",
					status: "pending",
					evidenceCount: 0,
				},
				{
					id: output.laneRunIds[1],
					lane: "source",
					agent: "Resercher",
					epistemicRole: "source_harvest",
					status: "pending",
					evidenceCount: 0,
				},
				{
					id: output.laneRunIds[2],
					lane: "social",
					agent: "Resercher_X",
					epistemicRole: "social_signal",
					status: "pending",
					evidenceCount: 0,
				},
			]);
			expect(
				missions.listLaneRuns(mission.id).map(run => [run.emptyReason, run.taskId, run.startedAt, run.endedAt]),
			).toEqual([
				[null, null, null, null],
				[null, null, null, null],
				[null, null, null, null],
			]);
		} finally {
			missions.close();
		}
	});

	it("prints text output and creates a new latest run each time", async () => {
		const db = testDb();
		const brief = await createBrief(db, "Should repeated runs be distinct?", "repo,source");

		const firstText = await captureStdout(async () => {
			await runResearchRunCommand({ db, briefId: brief.id });
		});
		const secondJson = JSON.parse(
			await captureStdout(async () => {
				await runResearchRunCommand({ db, briefId: brief.id, json: true });
			}),
		);

		const missions = new MissionStore(db);
		const readModel = new MissionReadModel({ dbPath: db });
		try {
			const mission = missions.listMissions({ briefId: brief.id })[0];
			const runs = missions.listResearchRuns({ missionId: mission.id });
			expect(runs).toHaveLength(2);
			expect(runs[0].id).toBe(secondJson.runId);
			expect(runs[1].id).not.toBe(secondJson.runId);
			expect(readModel.getMissionView(mission.id)?.researchRun?.id).toBe(secondJson.runId);
			expect(firstText).toContain(`started research run: ${runs[1].id} for mission ${mission.id}`);
			expect(firstText).toContain("  lane repo:");
			expect(firstText).toContain("  lane source:");
		} finally {
			readModel.close();
			missions.close();
		}
	});

	it("finalizes repeated runs independently through evidence and synthesis", async () => {
		const db = testDb();
		const brief = await createBrief(db, "Do repeated runs finalize independently?", "repo,source");
		const first = JSON.parse(
			await captureStdout(async () => {
				await runResearchRunCommand({ db, briefId: brief.id, json: true });
			}),
		);
		const second = JSON.parse(
			await captureStdout(async () => {
				await runResearchRunCommand({ db, briefId: brief.id, json: true });
			}),
		);

		await captureStdout(async () => {
			await runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "repo",
				grade: "A",
				source: "repo://live",
				excerpt: "Current run has evidence",
				claim: "claim",
				directness: 1,
				specificity: 1,
				recency: 1,
				reproducibility: 1,
				json: true,
			});
		});
		await runResearchRecordSynthesisCommand({
			db,
			briefId: brief.id,
			hypothesisCount: 1,
			summary: "done",
			rawText: "done",
			json: true,
		});
		// Synthesis leaves the run open by design; the critique (accept) finalizes it.
		await runResearchRecordCritiqueCommand({
			db,
			briefId: brief.id,
			blockingCount: 0,
			softCount: 0,
			verdict: "accept",
			summary: "looks good",
			rawText: "looks good",
			json: true,
		});

		const missions = new MissionStore(db);
		try {
			const firstRun = missions.getResearchRun(first.runId);
			const secondRun = missions.getResearchRun(second.runId);
			expect(firstRun?.status).toBe("running");
			expect(firstRun?.completedAt).toBeNull();
			expect(secondRun).toMatchObject({ status: "completed" });
			expect(secondRun?.completedAt).toBeNumber();
			expect(missions.getLatestLaneRunForMissionLane(second.missionId, "repo")).toMatchObject({
				id: second.laneRunIds[0],
				status: "completed",
				evidenceCount: 1,
			});
			expect(missions.getLatestLaneRunForMissionLane(second.missionId, "source")).toMatchObject({
				id: second.laneRunIds[1],
				status: "empty",
				emptyReason: "no evidence recorded",
			});
		} finally {
			missions.close();
		}
	});
});

async function createBrief(db: string, question: string, lanes: string): Promise<any> {
	const stdout = await captureStdout(async () => {
		await runResearchBriefCommand({ db, question, lanes, json: true });
	});
	return JSON.parse(stdout);
}

async function captureStdout(body: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	(process.stdout as any).write = (s: any) => {
		chunks.push(typeof s === "string" ? s : s.toString());
		return true;
	};
	try {
		await body();
		return chunks.join("");
	} finally {
		(process.stdout as any).write = orig;
	}
}
