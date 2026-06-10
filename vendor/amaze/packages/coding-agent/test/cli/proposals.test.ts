import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

describe("proposals CLI", () => {
	it("lists, approves, and rejects proposals from an override database", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-proposals-cli-"));
		const db = path.join(cleanupRoot, "proposals.db");
		const store = new ProposalStore(db);
		const approvable = store.create({
			type: "memory",
			gate: "review",
			evidence: { sessionIds: ["s1"], eventRefs: ["e1"], sampleN: 1 },
			provenance: { source: "manual" },
			content: "remember this",
			memoryType: "fact",
			confidence: "tool_verified",
		});
		const rejectable = store.create({
			type: "settings",
			gate: "human-required",
			evidence: { sessionIds: ["s2"], eventRefs: ["e2"], sampleN: 1 },
			provenance: { source: "manual" },
			patch: { model: "fast" },
			reason: "too slow",
			rollback: { model: "default" },
		});
		store.close();

		const listed = await runCli(cleanupRoot, ["proposals", "list", "--db", db, "--status", "pending"]);
		expect(listed.exitCode).toBe(0);
		expect(listed.stderr).toBe("");
		expect(listed.stdout).toContain(approvable.id);
		expect(listed.stdout).toContain("pending");
		expect(listed.stdout).toContain("memory");

		const approved = await runCli(cleanupRoot, ["proposals", "approve", approvable.id, "--db", db, "--reason", "ok"]);
		expect(approved.exitCode).toBe(0);
		expect(approved.stdout).toContain("approved");
		expect(approved.stdout).toContain(approvable.id);

		const rejected = await runCli(cleanupRoot, ["proposals", "reject", rejectable.id, "--db", db, "--reason", "bad"]);
		expect(rejected.exitCode).toBe(0);
		expect(rejected.stdout).toContain("rejected");
		expect(rejected.stdout).toContain(rejectable.id);
	});
});
