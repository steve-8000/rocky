import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runResearchAddEvidenceCommand,
	runResearchBriefCommand,
	runResearchCritiqueCommand,
	runResearchDecideCommand,
	runResearchListCommand,
	runResearchScoreCommand,
	runResearchShowCommand,
	runResearchSynthesizeCommand,
} from "../../src/cli/research";

let cleanupRoot: string | undefined;

function testDb(): string {
	cleanupRoot = path.join(os.tmpdir(), `amaze-research-${Date.now()}-${Math.random()}`);
	return path.join(cleanupRoot, "research.db");
}

afterEach(() => {
	if (cleanupRoot) {
		fs.rmSync(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("research CLI helpers", () => {
	it("creates a brief with JSON defaults", async () => {
		await captureStdout(async () => {
			const db = testDb();
			await runResearchBriefCommand({ db, question: "Should we trust this migration?", json: true });
		}).then(stdout => {
			const brief = JSON.parse(stdout);
			expect(brief.id.startsWith("research-")).toBe(true);
			expect(brief.lanes).toEqual(["repo", "source", "social", "memory"]);
			expect(brief.riskLevel).toBe("medium");
		});
	});

	it("lists empty briefs as text and JSON", async () => {
		const db = testDb();
		const text = await captureStdout(async () => {
			await runResearchListCommand({ db });
		});
		expect(text).toBe("id  risk  question\n");

		const json = await captureStdout(async () => {
			await runResearchListCommand({ db, json: true });
		});
		expect(JSON.parse(json)).toEqual([]);
	});

	it("scores a brief after adding evidence", async () => {
		const db = testDb();
		const brief = await createBrief(db, "How complementary is the evidence?");
		await captureStdout(async () => {
			await runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "repo",
				grade: "A",
				source: "packages/coding-agent/src/research/scoring.ts",
				excerpt: "Repo evidence documents scoring behavior.",
			});
			await runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "social",
				grade: "D",
				source: "https://x.example/status/1",
				excerpt: "A weak social signal exists.",
			});
		});

		const stdout = await captureStdout(async () => {
			await runResearchScoreCommand({ db, briefId: brief.id, json: true });
		});
		const score = JSON.parse(stdout);
		expect(score.total).toBeGreaterThan(0);
		expect(score.breakdown).toHaveLength(brief.lanes.length);
	});

	it("rejects invalid evidence lane and grade", async () => {
		const db = testDb();
		const brief = await createBrief(db, "Which evidence is valid?");
		await expect(
			runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "bad",
				grade: "A",
				source: "repo",
				excerpt: "x",
			}),
		).rejects.toThrow("Invalid lane: bad");
		await expect(
			runResearchAddEvidenceCommand({
				db,
				briefId: brief.id,
				lane: "repo",
				grade: "Z",
				source: "repo",
				excerpt: "x",
			}),
		).rejects.toThrow("Invalid grade: Z");
	});

	it("records and shows a typed decision", async () => {
		const db = testDb();
		const brief = await createBrief(db, "What decision should be recorded?");
		await captureStdout(async () => {
			await runResearchDecideCommand({
				db,
				briefId: brief.id,
				hypothesis: "Prefer the repo-grounded option",
				kind: "defer",
				confidence: "high",
				rationale: "Repo evidence is strongest.",
				evidence: "ev-1,ev-2",
			});
		});
		const stdout = await captureStdout(async () => {
			await runResearchShowCommand({ db, id: brief.id });
		});
		expect(stdout).toContain("decision:\n  hypothesis: Prefer the repo-grounded option");
		expect(stdout).toContain("  kind: defer");
	});

	it("renders synthesizer prompt", async () => {
		const db = testDb();
		const brief = await createBrief(db, "Should the synthesizer mention this question?");
		const stdout = await captureStdout(async () => {
			await runResearchSynthesizeCommand({ db, briefId: brief.id });
		});
		expect(stdout).toContain("RESEARCH SYNTHESIZER mode");
		expect(stdout).toContain("Should the synthesizer mention this question?");
	});

	it("renders critic prompt with inline synthesis", async () => {
		const db = testDb();
		const brief = await createBrief(db, "Should the critic review inline synthesis?");
		const stdout = await captureStdout(async () => {
			await runResearchCritiqueCommand({ db, briefId: brief.id, synthesis: "Inline synthesis fragment." });
		});
		expect(stdout).toContain("RESEARCH CRITIC mode");
		expect(stdout).toContain("Inline synthesis fragment.");
	});

	it("requires synthesis input for critique", async () => {
		const db = testDb();
		const brief = await createBrief(db, "What does critique require?");
		await expect(runResearchCritiqueCommand({ db, briefId: brief.id })).rejects.toThrow(
			"critique requires --synthesis <text> or --synthesis-file <path>",
		);
	});
});

async function createBrief(db: string, question: string): Promise<any> {
	const stdout = await captureStdout(async () => {
		await runResearchBriefCommand({ db, question, json: true });
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
