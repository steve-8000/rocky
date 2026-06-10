import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runResearchAddEvidenceCommand,
	runResearchBriefCommand,
	runResearchNextCommand,
	runResearchRecordCritiqueCommand,
	runResearchRecordSynthesisCommand,
	runResearchStatusCommand,
} from "../../src/cli/research";

let cleanupRoot: string | undefined;

function testDb(): string {
	cleanupRoot = path.join(os.tmpdir(), `amaze-research-status-${Date.now()}-${Math.random()}`);
	return path.join(cleanupRoot, "research.db");
}

afterEach(() => {
	if (cleanupRoot) {
		fs.rmSync(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("research status and next CLI helpers", () => {
	it("prints deterministic status as text and JSON", async () => {
		const db = testDb();
		const brief = await createBrief(db);
		await captureStdout(async () => {
			await runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "repo",
				grade: "A",
				source: "repo",
				excerpt: "Repo evidence.",
			});
		});

		const text = await captureStdout(async () => {
			await runResearchStatusCommand({ db, briefId: brief.id });
		});
		expect(text).toContain(`briefId: ${brief.id}`);
		expect(text).toContain("readiness: insufficient");
		expect(text).toContain("recommendedNextAction: collect-evidence");
		expect(text).toContain("incompleteLanes: source");

		const json = await captureStdout(async () => {
			await runResearchStatusCommand({ db, briefId: brief.id, json: true });
		});
		expect(JSON.parse(json)).toMatchObject({
			briefId: brief.id,
			readiness: "insufficient",
			incompleteLanes: ["source"],
			recommendedNextAction: "collect-evidence",
		});
	});

	it("prints next action after synthesis and critique", async () => {
		const db = testDb();
		const brief = await createBrief(db);
		await captureStdout(async () => {
			await runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "repo",
				grade: "A",
				source: "repo",
				excerpt: "Repo evidence.",
			});
			await runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "source",
				grade: "B",
				source: "source",
				excerpt: "Source evidence.",
			});
			await runResearchRecordSynthesisCommand({
				db,
				briefId: brief.id,
				hypothesisCount: 1,
				summary: "One grounded option.",
			});
		});

		await captureStdout(async () => {
			await runResearchNextCommand({ db, briefId: brief.id });
		}).then(stdout => expect(stdout).toBe("run-critique\n"));

		await captureStdout(async () => {
			await runResearchRecordCritiqueCommand({
				db,
				briefId: brief.id,
				blockingCount: 0,
				softCount: 0,
				verdict: "accept",
				summary: "No blockers.",
			});
		});

		const json = await captureStdout(async () => {
			await runResearchNextCommand({ db, briefId: brief.id, json: true });
		});
		expect(JSON.parse(json)).toMatchObject({
			briefId: brief.id,
			recommendedNextAction: "record-decision",
			assessment: { readiness: "ready-to-decide" },
		});
	});
});

async function createBrief(db: string): Promise<any> {
	const stdout = await captureStdout(async () => {
		await runResearchBriefCommand({
			db,
			question: "What is the next research action?",
			lanes: "repo,source",
			json: true,
		});
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
