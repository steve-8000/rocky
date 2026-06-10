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
			AMAZE_RULES_BUILTIN_DIR: path.join(root, "builtin"),
			AMAZE_RULES_USER_DIR: path.join(root, "user-rules"),
			AMAZE_RULES_PROJECT_DIR: path.join(root, "project-rules"),
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

describe("rules CLI", () => {
	it("lists one line per builtin rule file", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-rules-cli-"));
		const builtinDir = path.join(cleanupRoot, "builtin");
		await fs.mkdir(builtinDir, { recursive: true });
		await fs.writeFile(path.join(builtinDir, "alpha.rule.md"), ruleMarkdown("alpha"), "utf8");
		await fs.writeFile(path.join(builtinDir, "beta.rule.md"), ruleMarkdown("beta"), "utf8");

		const { stdout, stderr, exitCode } = await runCli(cleanupRoot, ["rules", "list"]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const lines = stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("alpha");
		expect(lines[1]).toContain("beta");
	});
});

function ruleMarkdown(id: string): string {
	return `---
id: ${id}
name: ${id}
group: test
severity: warning
trust: built-in
---
# Description
${id} description

# Examples
${id} example

\`\`\`detect
scan: events
match: $.type == "turn.start"
aggregate: count
check: count > 0
\`\`\`
`;
}
