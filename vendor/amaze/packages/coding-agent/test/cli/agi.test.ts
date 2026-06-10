import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgiGatewayStore, buildAgiCompletionState } from "../../src/agi/store";

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

function gatewayDbPath(root: string): string {
	return path.join(root, "agi", "gateway.db");
}

async function runCli(root: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			AMAZE_CODING_AGENT_DIR: agentDir,
			AMAZE_AGI_DB: gatewayDbPath(root),
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

describe("agi CLI", () => {
	it("starts in non-TTY mode with an empty gateway status", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-agi-cli-"));

		const result = await runCli(cleanupRoot, ["agi"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("AGI Gateway score: 0/100");
		expect(result.stdout).toContain("No monitored sessions");
	});

	it("adds a session path and shows it in status", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-agi-cli-"));
		const sessionDir = path.join(cleanupRoot, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1", timestamp: new Date().toISOString(), cwd: repoRoot, title: "AGI test session" })}\n`,
		);

		const added = await runCli(cleanupRoot, ["agi", "add", "--session", sessionFile]);
		expect(added.exitCode).toBe(0);
		expect(added.stderr).toBe("");
		expect(added.stdout).toContain("s1");
		expect(added.stdout).toContain("watching");
		expect(added.stdout).toContain("20/100");

		const status = await runCli(cleanupRoot, ["agi", "status"]);
		expect(status.exitCode).toBe(0);
		expect(status.stderr).toBe("");
		expect(status.stdout).toContain("AGI Gateway score: 20/100");
		expect(status.stdout).toContain("AGI test session");
		expect(status.stdout).toContain(sessionFile);
	});

	it("runs one supervisor tick and reaches 100 only with a structured completion marker", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-agi-cli-"));
		const sessionDir = path.join(cleanupRoot, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					id: "s1",
					timestamp: new Date().toISOString(),
					cwd: repoRoot,
					title: "AGI completed session",
				}),
				JSON.stringify({
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: 'All AGI controls are wired.\nAGI_GATEWAY_RESULT {"score":100,"complete":true,"satisfiedCriteria":["context_boundaries_preserved","initial_build_goal_complete"],"summary":"All AGI controls are wired."}',
							},
						],
						api: "test",
						provider: "test",
						model: "test",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "endTurn",
					},
				}),
				"",
			].join("\n"),
		);

		const added = await runCli(cleanupRoot, ["agi", "add", "--session", sessionFile]);
		expect(added.exitCode).toBe(0);

		const store = new AgiGatewayStore(gatewayDbPath(cleanupRoot));
		try {
			const session = store.getSession("s1");
			if (!session) throw new Error("Expected AGI session");
			const completionState = buildAgiCompletionState(session.goalSpec, {
				score: 60,
				complete: false,
				structuredResultSeen: false,
				summary: session.completionState.summary,
				agentSatisfiedCriteria: [],
				supervisorSatisfiedCriteria: ["monitored_by_gateway", "follow_up_turn_executed"],
			});
			store.updateSession("s1", { score: 60, completionState });
		} finally {
			store.close();
		}

		const run = await runCli(cleanupRoot, ["agi", "run", "--once"]);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.stdout).toContain("AGI Gateway score: 100/100");

		const status = await runCli(cleanupRoot, ["agi", "status"]);
		expect(status.stdout).toContain("completed");
		expect(status.stdout).toContain("100/100");
	});

	it("supports pause resume unblock and remove controls", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-agi-cli-"));
		const sessionDir = path.join(cleanupRoot, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1", timestamp: new Date().toISOString(), cwd: repoRoot, title: "AGI controls" })}\n`,
		);
		expect((await runCli(cleanupRoot, ["agi", "add", "--session", sessionFile])).exitCode).toBe(0);

		const paused = await runCli(cleanupRoot, ["agi", "pause", "--session", "s1"]);
		expect(paused.stdout).toContain("paused");

		const resumed = await runCli(cleanupRoot, ["agi", "resume", "--session", "s1"]);
		expect(resumed.stdout).toContain("watching");

		const store = new AgiGatewayStore(gatewayDbPath(cleanupRoot));
		try {
			const session = store.getSession("s1");
			if (!session) throw new Error("Expected AGI session");
			store.updateSession("s1", {
				state: "blocked",
				score: session.score,
				completionState: session.completionState,
				controlState: {
					...session.controlState,
					retryCount: 3,
					blockedReason: "manual test block",
				},
			});
		} finally {
			store.close();
		}

		const unblocked = await runCli(cleanupRoot, ["agi", "unblock", "--session", "s1"]);
		expect(unblocked.stdout).toContain("watching");

		const removed = await runCli(cleanupRoot, ["agi", "remove", "--session", "s1"]);
		expect(removed.stdout).toContain("removed");
	});

	it("prints gateway events and actions", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-agi-cli-"));
		const sessionDir = path.join(cleanupRoot, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1", timestamp: new Date().toISOString(), cwd: repoRoot, title: "AGI inspect" })}\n`,
		);
		expect((await runCli(cleanupRoot, ["agi", "add", "--session", sessionFile])).exitCode).toBe(0);

		const store = new AgiGatewayStore(gatewayDbPath(cleanupRoot));
		try {
			store.recordEvent("s1", "session.turn_completed", { summary: "inspect me" }, { id: "ev1", createdAt: 1 });
			store.createAction({
				sessionId: "s1",
				eventId: "ev1",
				actionType: "follow_up_turn",
				instruction: "continue",
			});
		} finally {
			store.close();
		}

		const events = await runCli(cleanupRoot, ["agi", "events", "--session", "s1"]);
		expect(events.stdout).toContain("session.turn_completed");
		expect(events.stdout).toContain("inspect me");

		const actions = await runCli(cleanupRoot, ["agi", "actions", "--session", "s1"]);
		expect(actions.stdout).toContain("follow_up_turn");
		expect(actions.stdout).toContain("pending");
	});

	it("stores and reports a preferred model for a monitored session", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-agi-cli-"));
		const sessionDir = path.join(cleanupRoot, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1", timestamp: new Date().toISOString(), cwd: repoRoot, title: "AGI model" })}\n`,
		);
		expect((await runCli(cleanupRoot, ["agi", "add", "--session", sessionFile])).exitCode).toBe(0);

		const store = new AgiGatewayStore(gatewayDbPath(cleanupRoot));
		try {
			const session = store.getSession("s1");
			if (!session) throw new Error("Expected AGI session");
			store.updateSession("s1", {
				state: session.state,
				preferredModel: "openai/gpt-5.2",
				score: session.score,
				completionState: session.completionState,
				controlState: session.controlState,
			});
		} finally {
			store.close();
		}

		const status = await runCli(cleanupRoot, ["agi", "status"]);
		expect(status.stdout).toContain("openai/gpt-5.2");
	});
});
