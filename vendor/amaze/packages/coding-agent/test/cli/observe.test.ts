import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus, JsonlSessionSink } from "../../src/observability";

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
	const xdg = path.join(root, "xdg");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(xdg, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });

	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: xdg,
			XDG_DATA_HOME: xdg,
			AMAZE_CODING_AGENT_DIR: agentDir,
			AMAZE_OBSERVABILITY_DIR: path.join(root, "observability"),
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

describe("observe CLI", () => {
	it("exports jsonl lines for a session", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-observe-cli-"));
		const bus = new EventBus();
		const sink = new JsonlSessionSink(bus, {
			baseDir: path.join(cleanupRoot, "observability"),
			batchSize: 1,
			flushIntervalMs: 1,
		});

		bus.emit({ type: "session.start", sessionId: "s1", ts: 100, cwd: repoRoot, agent: "test" });
		bus.emit({ type: "turn.start", sessionId: "s1", ts: 110, turn: 1 });
		bus.emit({ type: "turn.end", sessionId: "s1", ts: 120, turn: 1, usage: { input: 1, output: 2 } });
		await new Promise(resolve => setTimeout(resolve, 0));
		await sink.close();

		const { stdout, stderr, exitCode } = await runCli(cleanupRoot, ["observe", "export", "--session", "s1"]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout.trim().split("\n")).toHaveLength(3);
	});
});
