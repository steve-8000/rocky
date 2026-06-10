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

async function runMemoryDoctorWithConfig(
	config: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-memory-doctor-settings-"));
	cleanupRoot = root;
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	const agentDir = path.join(home, ".amaze", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	await fs.writeFile(path.join(agentDir, "config.yml"), config, "utf-8");

	const proc = Bun.spawn([process.execPath, cliEntry, "memory", "doctor"], {
		cwd: project,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			AMAZE_NO_TITLE: "1",
			NO_COLOR: "1",
			AMAZE_CODING_AGENT_DIR: agentDir,
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

describe("memory command settings loading", () => {
	it("loads persisted config before running memory doctor", async () => {
		const { stdout, stderr, exitCode } = await runMemoryDoctorWithConfig(
			`agencyBrain:\n  enabled: true\n  mcpServer: gbrain\n`,
		);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("Memory backend: removed");
		expect(stdout).toContain("GBrain Agency Brain via MCP");
	});
});
