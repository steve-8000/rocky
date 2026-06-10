import { afterEach, describe, expect, it } from "bun:test";
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

describe("metrics CLI", () => {
	it("shows metrics computed from a JSONL sink file", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-metrics-cli-"));
		const sink = path.join(cleanupRoot, "events.jsonl");
		await fs.writeFile(
			sink,
			`${JSON.stringify({ type: "goal.complete", sessionId: "s1", ts: Date.now(), goalId: "g1", verdict: "pass", failedCount: 0, uncertainCount: 0 })}\n`,
			"utf8",
		);

		const { stdout, stderr, exitCode } = await runCli(cleanupRoot, ["metrics", "show", "--sink", sink]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("goal.completion.passRate");
	});
});
