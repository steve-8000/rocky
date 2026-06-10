import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRules } from "../../src/rules/loader";

const TRUSTED_PATH = join(homedir(), ".amaze", "rules", ".trusted.json");
const BACKUP_PATH = `${TRUSTED_PATH}.loader-trust-test-backup`;

const builtinRule = ruleMarkdown({ id: "builtin-rule", trust: "built-in", maxRate: 0.9 });
const projectRule = ruleMarkdown({ id: "project-rule", trust: "project", maxRate: 0.1 });

describe("loadRules trust gate", () => {
	let tmpDir: string;
	let hadTrusted = false;

	beforeEach(async () => {
		hadTrusted = await fileExists(TRUSTED_PATH);
		if (hadTrusted) await writeFile(BACKUP_PATH, await readFile(TRUSTED_PATH));
		await rm(TRUSTED_PATH, { force: true });

		tmpDir = await Bun.$`mktemp -d`.text();
		tmpDir = tmpDir.trim();
		await mkdir(join(tmpDir, "builtin"), { recursive: true });
		await mkdir(join(tmpDir, "project"), { recursive: true });
		await writeFile(join(tmpDir, "builtin", "builtin.rule.md"), builtinRule);
		await writeFile(join(tmpDir, "project", "project.rule.md"), projectRule);
	});

	afterEach(async () => {
		await rm(tmpDir, { force: true, recursive: true });
		await rm(TRUSTED_PATH, { force: true });
		if (hadTrusted) {
			await mkdir(join(homedir(), ".amaze", "rules"), { recursive: true });
			await writeFile(TRUSTED_PATH, await readFile(BACKUP_PATH));
		}
		await rm(BACKUP_PATH, { force: true });
	});

	test("skips an untrusted project rule when approval is denied", async () => {
		const loaded = await loadRules({
			builtinDir: join(tmpDir, "builtin"),
			projectDir: join(tmpDir, "project"),
			approve: async () => false,
		});

		expect(loaded.map(item => item.rule.id)).toEqual(["builtin-rule"]);
		expect(loaded[0]?.source).toBe("builtin");
		expect(await fileExists(TRUSTED_PATH)).toBe(false);
	});

	test("records an approved project hash and does not ask again", async () => {
		const approvals: string[] = [];
		const first = await loadRules({
			builtinDir: join(tmpDir, "builtin"),
			projectDir: join(tmpDir, "project"),
			approve: async (_path, hash) => {
				approvals.push(hash);
				return true;
			},
		});

		expect(first.map(item => item.rule.id)).toEqual(["builtin-rule", "project-rule"]);
		expect(approvals).toHaveLength(1);
		const trusted = JSON.parse(await readFile(TRUSTED_PATH, "utf8")) as { hashes: string[] };
		expect(trusted.hashes).toContain(approvals[0]);

		const secondApprovals: string[] = [];
		const second = await loadRules({
			builtinDir: join(tmpDir, "builtin"),
			projectDir: join(tmpDir, "project"),
			approve: async (_path, hash) => {
				secondApprovals.push(hash);
				return false;
			},
		});

		expect(second.map(item => item.rule.id)).toEqual(["builtin-rule", "project-rule"]);
		expect(secondApprovals).toEqual([]);
	});
});

function ruleMarkdown({ id, trust, maxRate }: { id: string; trust: "built-in" | "project"; maxRate: number }): string {
	return `---
id: ${id}
name: ${id}
group: loader-test
severity: warning
trust: ${trust}
fileTypes: []
inherits: []
---

# Description
${id} description.

# Detection

\`\`\`detect
scan: events
match: $.type == "loader.test"
aggregate: count
window: { last: 10 }
check: $count / $windowSize > thresholds.maxRate
thresholds:
  maxRate: ${maxRate}
\`\`\`

# Examples
- ${id} example.

# How to Improve
Improve ${id}.
`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
