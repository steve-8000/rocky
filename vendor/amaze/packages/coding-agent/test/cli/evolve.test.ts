import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ObjectiveStore } from "../../src/autonomy";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

let cleanupRoot: string | undefined;

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function runCli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliEntry, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: root,
			AMAZE_CODING_AGENT_DIR: path.join(root, "agent"),
			AMAZE_NO_TITLE: "1",
			NO_COLOR: "1",
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readStream(proc.stdout as ReadableStream<Uint8Array>),
		readStream(proc.stderr as ReadableStream<Uint8Array>),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

afterEach(async () => {
	if (cleanupRoot) {
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("evolve CLI", () => {
	it("evolve status reports zero state on a fresh HOME", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-evolve-cli-"));

		const result = await runCli(cleanupRoot, ["evolve", "status"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("EVOLUTION STATE");
		expect(result.stdout).toContain("Active objectives: 0");
		expect(result.stdout).toContain("Pending proposals: 0");
		expect(result.stdout).toContain("No active evolution flow.");
	});

	it("evolve help lists action options", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-evolve-cli-"));

		const result = await runCli(cleanupRoot, ["evolve", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("status");
		expect(result.stdout).toContain("doctor");
		expect(result.stdout).toContain("rollback");
		expect(result.stdout).toContain("simulate");
	});

	it("evolve doctor lists default forbidden scopes", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-evolve-cli-"));

		const result = await runCli(cleanupRoot, ["evolve", "doctor"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain(".amaze/settings.json");
		expect(result.stdout).toContain(".git/**");
		expect(result.stdout).toContain("AGENTS.md");
		expect(result.stdout).toContain("packages/coding-agent/src/learning/**");
	});

	it("evolve objectives delegates to objective list", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-evolve-cli-"));

		const result = await runCli(cleanupRoot, ["evolve", "objectives"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("No objectives");
	});

	it("evolve preview without --objective fails with usage error", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-evolve-cli-"));

		const result = await runCli(cleanupRoot, ["evolve", "preview"]);

		expect(result.exitCode).not.toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/objective|id/);
	});

	it("evolve preview annotates settings proposal guardrail status", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-evolve-cli-"));
		const objectivesDb = path.join(cleanupRoot, "objectives.db");
		const metricsPath = path.join(cleanupRoot, "metrics.json");
		await fs.mkdir(path.join(cleanupRoot, "agent"), { recursive: true });
		await fs.writeFile(path.join(cleanupRoot, "agent", "config.yml"), "goal:\n  uncertainPolicy: allow\n");

		const createResult = await runCli(cleanupRoot, [
			"objective",
			"create",
			"--db",
			objectivesDb,
			"--title",
			"Reduce force complete rate",
			"--metric",
			"goal.forceCompleteRate",
			"--target",
			"0.1",
			"--direction",
			"down",
		]);
		expect(createResult.exitCode).toBe(0);
		expect(createResult.stderr).toBe("");
		const objectiveId = createResult.stdout.split("\t")[0];
		await fs.writeFile(metricsPath, JSON.stringify({ "goal.forceCompleteRate": 0.5 }));

		const result = await runCli(cleanupRoot, [
			"evolve",
			"preview",
			"--db",
			objectivesDb,
			"--objective",
			objectiveId,
			"--metrics",
			metricsPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("guardrail:");
		expect(result.stdout).toContain("blocked");
		expect(result.stdout).toContain(".amaze/settings.json");
	});

	it("evolve status lists recent evolution events for active objectives", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-evolve-cli-"));
		const objectivesDb = path.join(cleanupRoot, "objectives.db");
		const store = new ObjectiveStore(objectivesDb);
		const objective = store.create({
			title: "Reduce blocks",
			metricTargets: [{ metric: "guardrail.blockRate", target: 0.1, direction: "down" }],
			budget: {},
		});
		store.recordEvent(objective.id, "blocked", { reason: "budget" });
		store.close();

		const result = await runCli(cleanupRoot, ["evolve", "status", "--db", objectivesDb]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain(`Recent evolution events for ${objective.id}:`);
		expect(result.stdout).toContain("blocked");
	});
});
