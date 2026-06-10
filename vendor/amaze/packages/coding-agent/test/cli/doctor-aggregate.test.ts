import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@amaze/utils";

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

async function runDoctorAll(
	actions: unknown[],
): Promise<{ stdout: string; stderr: string; exitCode: number; json: any }> {
	const root = path.join(os.tmpdir(), "amaze-doctor-aggregate-", Snowflake.next());
	cleanupRoot = root;
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(home, ".amaze", "agent"), { recursive: true });
	fs.mkdirSync(path.join(project, ".amaze"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".amaze", "agent", "config.yml"),
		`doctor:\n  all:\n    actions: ${JSON.stringify(actions)}\n`,
		"utf8",
	);
	const proc = Bun.spawn([process.execPath, cliEntry, "doctor", "all", "--json"], {
		cwd: project,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			AMAZE_CODING_AGENT_DIR: path.join(home, ".amaze", "agent"),
			AMAZE_NO_TITLE: "1",
			NO_COLOR: "1",
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readStream(proc.stdout as ReadableStream<Uint8Array>),
		readStream(proc.stderr as ReadableStream<Uint8Array>),
		proc.exited,
	]);
	return { stdout, stderr, exitCode, json: JSON.parse(stdout) };
}

afterEach(() => {
	if (cleanupRoot) fs.rmSync(cleanupRoot, { recursive: true, force: true });
	cleanupRoot = undefined;
});

describe("doctor all aggregate", () => {
	test("explicit doctor.all.actions runs only selected actions", async () => {
		const { json } = await runDoctorAll(["security", "config"]);
		expect(Object.keys(json.perAction).sort()).toEqual(["config", "security"]);
		expect(json.perAction.security.status).toBeDefined();
		expect(json.perAction.config.status).toBeDefined();
	});

	test("empty doctor.all.actions is an ok no-op aggregate", async () => {
		const { json, exitCode } = await runDoctorAll([]);
		expect(exitCode).toBe(0);
		expect(json).toEqual({ status: "ok", findings: [], perAction: {} });
	});

	test("unknown configured action warns without throwing", async () => {
		const { json, stderr } = await runDoctorAll(["security", "bogus"]);
		expect(json.perAction.security).toBeDefined();
		expect(stderr).toContain("Unknown doctor.all.actions entries ignored: bogus");
	});

	test("json envelope has status findings and perAction", async () => {
		const { json } = await runDoctorAll(["config"]);
		expect(typeof json.status).toBe("string");
		expect(Array.isArray(json.findings)).toBe(true);
		expect(typeof json.perAction).toBe("object");
		expect(json.perAction.config).toBeDefined();
		expect(typeof json.perAction.config.status).toBe("string");
		expect(Array.isArray(json.perAction.config.findings)).toBe(true);
	});
});
