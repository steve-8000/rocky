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

describe("objective CLI", () => {
	it("creates, lists, shows, and pauses objectives from an override database", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-objective-cli-"));
		const db = path.join(cleanupRoot, "objectives.db");

		const created = await runCli(cleanupRoot, [
			"objective",
			"create",
			"--db",
			db,
			"--title",
			"Reduce force complete rate",
			"--metric",
			"force_complete_rate",
			"--target",
			"0.01",
			"--direction",
			"down",
		]);
		expect(created.exitCode).toBe(0);
		expect(created.stderr).toBe("");
		expect(created.stdout).toContain("active");
		const id = created.stdout.split("\t")[0];
		expect(id.length).toBeGreaterThan(0);

		const listed = await runCli(cleanupRoot, ["objective", "list", "--db", db]);
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout).toContain(id);
		expect(listed.stdout).toContain("Reduce force complete rate");

		const shown = await runCli(cleanupRoot, ["objective", "show", id, "--db", db]);
		expect(shown.exitCode).toBe(0);
		expect(JSON.parse(shown.stdout)).toMatchObject({ id, status: "active", title: "Reduce force complete rate" });

		const paused = await runCli(cleanupRoot, ["objective", "pause", id, "--db", db]);
		expect(paused.exitCode).toBe(0);
		expect(paused.stdout).toContain(id);
		expect(paused.stdout).toContain("paused");
	});
});
