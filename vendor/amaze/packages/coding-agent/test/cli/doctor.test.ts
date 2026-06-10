import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

async function runCli(
	root: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const home = path.join(root, "home");
	const observability = path.join(home, ".amaze", "observability");
	await fs.mkdir(path.join(observability, "sessions"), { recursive: true });
	await fs.writeFile(path.join(observability, "sessions", "doctor-smoke.jsonl"), "{}\n", "utf8");
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			AMAZE_OBSERVABILITY_DIR: observability,
			AMAZE_NO_TITLE: "1",
			NO_COLOR: "1",
			...env,
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readStream(proc.stdout as ReadableStream<Uint8Array>),
		readStream(proc.stderr as ReadableStream<Uint8Array>),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function makeRoot(): Promise<string> {
	cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-doctor-cli-"));
	return cleanupRoot;
}

afterEach(async () => {
	mock.restore();
	if (cleanupRoot) {
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("doctor CLI", () => {
	it("reports ok for a clean environment", async () => {
		const root = await makeRoot();
		const { stdout, stderr, exitCode } = await runCli(root, ["doctor"]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("Memory subsystem:");
		expect(stdout).toContain("Metrics availability:");
		expect(stdout).toContain("Rules engine:");
		expect(stdout).toContain("Observability sink:");
		expect(stdout).toContain("Status: ok");
	});

	it("degrades and identifies a rule that throws during smoke evaluation", async () => {
		const { runDoctorCommand } = await import("../../src/cli/doctor");
		const root = await makeRoot();
		const ruleDir = path.join(root, "rules");
		await fs.mkdir(ruleDir, { recursive: true });
		await fs.writeFile(
			path.join(ruleDir, "thrower.rule.md"),
			[
				"---",
				"id: doctor.thrower",
				"name: Thrower",
				"group: doctor",
				"severity: warning",
				"trust: built-in",
				"---",
				"",
				"```detect",
				"scan: events",
				'match: "\'"',
				"aggregate: count",
				'check: "$count > 0"',
				"```",
				"",
				"# Description",
				"Throws in expression compilation.",
				"",
				"# Examples",
				"None.",
				"# How to Improve",
				"Fix it.",
				"",
			].join("\n"),
			"utf8",
		);
		const sessions = path.join(root, "observability", "sessions");
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(path.join(sessions, "recent.jsonl"), "{}\n", "utf8");
		let stdout = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			const report = await runDoctorCommand({
				observabilityDir: path.join(root, "observability"),
				builtinRulesDir: ruleDir,
				userRulesDir: path.join(root, "missing-user"),
				projectRulesDir: path.join(root, "missing-project"),
			});
			expect(report.status).toBe("degraded");
			expect(report.rules.throwingRuleIds).toEqual(["doctor.thrower"]);
			expect(stdout).toContain("doctor.thrower");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	it("prints parseable JSON with all four sections", async () => {
		const root = await makeRoot();
		const { stdout, stderr, exitCode } = await runCli(root, ["doctor", "--json"]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const parsed = JSON.parse(stdout);
		expect(parsed.status).toBe("ok");
		expect(parsed.memory).toBeTruthy();
		expect(parsed.metrics).toBeTruthy();
		expect(parsed.rules).toBeTruthy();
		expect(parsed.observability).toBeTruthy();
	});

	it("fails when memory doctor throws", async () => {
		const memory = await import("../../src/cli/memory");
		mock.module("../../src/cli/memory", () => ({
			...memory,
			getMemoryDoctorReport: () => {
				throw new Error("memory exploded");
			},
		}));
		const { runDoctorCommand } = await import("../../src/cli/doctor");
		let stdout = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			const root = await makeRoot();
			const sessions = path.join(root, "observability", "sessions");
			await fs.mkdir(sessions, { recursive: true });
			await fs.writeFile(path.join(sessions, "recent.jsonl"), "{}\n", "utf8");
			const report = await runDoctorCommand({ observabilityDir: path.join(root, "observability") });
			expect(report.status).toBe("failed");
			expect(report.memory.error).toBe("memory exploded");
			expect(stdout).toContain("Status: failed");
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});
