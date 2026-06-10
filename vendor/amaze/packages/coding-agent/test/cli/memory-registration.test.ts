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

async function runCliHelp(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-memory-registration-"));
	cleanupRoot = root;
	const home = path.join(root, "home");
	const xdg = path.join(root, "xdg");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(xdg, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });

	const proc = Bun.spawn([process.execPath, cliEntry, "memory", "--help"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: xdg,
			XDG_DATA_HOME: xdg,
			AMAZE_CODING_AGENT_DIR: agentDir,
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

describe("memory CLI registration", () => {
	it("advertises the maintenance actions", async () => {
		const { stdout, stderr, exitCode } = await runCliHelp();

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("doctor");
		expect(stdout).toContain("sync");
		expect(stdout).toContain("migrate");
	});
});
