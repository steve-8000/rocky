import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ObjectiveStore } from "../../src/autonomy";
import { ProposalStore } from "../../src/learning";

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
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: home, AMAZE_NO_TITLE: "1", NO_COLOR: "1" },
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

describe("objective preview CLI", () => {
	it("prints proposal JSON for mismatched metrics without mutating ProposalStore", async () => {
		const fixture = await createFixture();
		const proposalStore = new ProposalStore(fixture.proposalsDb);
		const before = proposalStore.listByStatus("pending").length;
		proposalStore.close();

		const result = await runCli(fixture.root, [
			"objective",
			"preview",
			"--id",
			fixture.objectiveId,
			"--db",
			fixture.objectivesDb,
			"--metrics",
			fixture.metricsMismatch,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.stdout);
		const proposal = parsed.proposal;
		expect(parsed.limitDecision.allow).toBe(true);
		expect(parsed.trace).toBeDefined();
		expect(parsed.trace.stage).toBeDefined();
		expect(proposal).toMatchObject({
			type: "rule",
			status: "pending",
			gate: "human-required",
			evidence: { sessionIds: [], sampleN: 1 },
			provenance: { source: "reflection", objectiveId: fixture.objectiveId },
		});
		expect(proposal.ruleMarkdown).toContain("custom.previewMetric");
		expect(proposal.expectedImpact).toBe("Move custom.previewMetric down toward 0.1.");
		expect(proposal.id).toContain(`autonomy-${fixture.objectiveId}-custom.previewMetric-`);

		const afterStore = new ProposalStore(fixture.proposalsDb);
		expect(afterStore.listByStatus("pending").length).toBe(before);
		afterStore.close();
	});

	it("prints no-remediation message when metrics satisfy the objective", async () => {
		const fixture = await createFixture();
		const result = await runCli(fixture.root, [
			"objective",
			"preview",
			"--id",
			fixture.objectiveId,
			"--db",
			fixture.objectivesDb,
			"--metrics",
			fixture.metricsSatisfied,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(`no remediation needed for objective ${fixture.objectiveId}\n`);
	});

	it("fails for an unknown objective id", async () => {
		const fixture = await createFixture();
		const result = await runCli(fixture.root, [
			"objective",
			"preview",
			"--id",
			"missing-objective",
			"--db",
			fixture.objectivesDb,
			"--metrics",
			fixture.metricsMismatch,
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Objective not found: missing-objective");
	});

	it("works when autonomy.enabled is false", async () => {
		const fixture = await createFixture();
		await fs.mkdir(path.join(fixture.root, "home", ".amaze"), { recursive: true });
		await fs.writeFile(path.join(fixture.root, "home", ".amaze", "config.yml"), "autonomy:\n  enabled: false\n");

		const result = await runCli(fixture.root, [
			"objective",
			"preview",
			"--id",
			fixture.objectiveId,
			"--db",
			fixture.objectivesDb,
			"--metrics",
			fixture.metricsMismatch,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.stdout);
		expect(parsed.proposal).toMatchObject({ type: "rule", evidence: { sessionIds: [] } });
		expect(parsed.limitDecision.allow).toBe(true);
		expect(parsed.trace).toBeDefined();
		expect(parsed.trace.stage).toBeDefined();
	});
});

async function createFixture(): Promise<{
	root: string;
	objectivesDb: string;
	proposalsDb: string;
	objectiveId: string;
	metricsMismatch: string;
	metricsSatisfied: string;
}> {
	cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-objective-preview-cli-"));
	const objectivesDb = path.join(cleanupRoot, "objectives.db");
	const proposalsDb = path.join(cleanupRoot, "proposals.db");
	const store = new ObjectiveStore(objectivesDb);
	const objective = store.create({
		title: "Reduce force complete rate",
		metricTargets: [{ metric: "custom.previewMetric", target: 0.1, direction: "down" }],
		budget: {},
		guardrails: { requireHumanForApply: true, maxAutoSubgoalsPerDay: 1, forbiddenScopes: [] },
	});
	store.close();

	const metricsMismatch = path.join(cleanupRoot, "mismatch.json");
	const metricsSatisfied = path.join(cleanupRoot, "satisfied.json");
	await fs.writeFile(metricsMismatch, JSON.stringify({ "custom.previewMetric": 0.5 }));
	await fs.writeFile(metricsSatisfied, JSON.stringify({ "custom.previewMetric": 0.01 }));

	return {
		root: cleanupRoot,
		objectivesDb,
		proposalsDb,
		objectiveId: objective.id,
		metricsMismatch,
		metricsSatisfied,
	};
}
