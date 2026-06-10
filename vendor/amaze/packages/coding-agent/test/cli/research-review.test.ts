import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runResearchBriefCommand,
	runResearchRecordCritiqueCommand,
	runResearchRecordSynthesisCommand,
	runResearchShowCommand,
} from "../../src/cli/research";

let cleanupRoot: string | undefined;

function testDb(): string {
	cleanupRoot = path.join(os.tmpdir(), `amaze-research-review-${Date.now()}-${Math.random()}`);
	return path.join(cleanupRoot, "research.db");
}

afterEach(() => {
	if (cleanupRoot) {
		fs.rmSync(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("research review CLI helpers", () => {
	it("records synthesis and critique rows and shows latest review blocks", async () => {
		const db = testDb();
		const brief = await createBrief(db, "Which synthesis should be persisted?");
		const rawPath = path.join(path.dirname(db), "critique.txt");
		fs.mkdirSync(path.dirname(rawPath), { recursive: true });
		fs.writeFileSync(rawPath, "Raw critique from file.");

		const synthesisText = await captureStdout(async () => {
			await runResearchRecordSynthesisCommand({
				db,
				briefId: brief.id,
				hypothesisCount: 3,
				recommended: "H2",
				summary: "H2 is best.",
				rawText: "Raw synthesis text.",
			});
		});
		expect(synthesisText).toContain(`recorded synthesis: syn-`);
		expect(synthesisText).toContain(` on brief ${brief.id}`);

		const critiqueJson = await captureStdout(async () => {
			await runResearchRecordCritiqueCommand({
				db,
				briefId: brief.id,
				blockingCount: 1,
				softCount: 2,
				verdict: "reject",
				summary: "Reject until blocker is resolved.",
				rawFile: rawPath,
				json: true,
			});
		});
		const critique = JSON.parse(critiqueJson);
		expect(critique.id.startsWith("crit-")).toBe(true);
		expect(critique.rawOutput).toBe("Raw critique from file.");

		const showText = await captureStdout(async () => {
			await runResearchShowCommand({ db, id: brief.id });
		});
		expect(showText).toContain("synthesis:\n  syn-");
		expect(showText).toContain("hypotheses=3");
		expect(showText).toContain("critique:\n  crit-");
		expect(showText).toContain("verdict=reject");

		const showJson = await captureStdout(async () => {
			await runResearchShowCommand({ db, id: brief.id, json: true });
		});
		const shown = JSON.parse(showJson);
		expect(shown.synthesis.summary).toBe("H2 is best.");
		expect(shown.synthesis.rawOutput).toBe("Raw synthesis text.");
		expect(shown.critique.summary).toBe("Reject until blocker is resolved.");
	});

	it("uses summary as raw output fallback and rejects invalid verdict", async () => {
		const db = testDb();
		const brief = await createBrief(db, "What is the raw output fallback?");

		const synthesisJson = await captureStdout(async () => {
			await runResearchRecordSynthesisCommand({
				db,
				briefId: brief.id,
				hypothesisCount: 1,
				summary: "Summary only.",
				json: true,
			});
		});
		expect(JSON.parse(synthesisJson).rawOutput).toBe("Summary only.");

		await expect(
			runResearchRecordCritiqueCommand({
				db,
				briefId: brief.id,
				blockingCount: 0,
				softCount: 0,
				verdict: "maybe",
				summary: "Invalid.",
			}),
		).rejects.toThrow("Invalid verdict: maybe");
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
