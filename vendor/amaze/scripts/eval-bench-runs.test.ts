import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT_PATH = path.resolve(import.meta.dir, "eval-bench-runs.ts");
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-eval-bench-"));
	tempDirs.push(dir);
	return dir;
}

async function writeReport(
	dir: string,
	name: string,
	overrides: { totalRuns?: string; successfulRuns?: string; verifiedRate?: string; editToolUsageRate?: string; editTotal?: string } = {},
): Promise<void> {
	const report = [
		"# Edit Benchmark Report",
		"",
		"| Metric | Value |",
		"|--------|-------|",
		"| Total Tasks | 1,234 |",
		`| Total Runs | ${overrides.totalRuns ?? "1,234"} |`,
		`| Successful Runs | ${overrides.successfulRuns ?? "1,000"} |`,
		"| **Task Success Rate** | **81.0% (1,000/1,234)** |",
		`| Verified Rate | ${overrides.verifiedRate ?? "75.0% (900/1,200)"} |`,
		`| Edit Tool Usage Rate | ${overrides.editToolUsageRate ?? "100.0% (1,234/1,234)"} |`,
		"| **Edit Success Rate** | **50.0%** |",
		"| Timeout Runs | 12 |",
		"| Tasks All Passing | 1,100 |",
		"| Tasks Flaky/Failing | 134 |",
		"| Input Tokens | 10,000 | 8 |",
		"| Output Tokens | 5,000 | 4 |",
		"| Total Tokens | 15,000 | 12 |",
		"| Duration | 1m | 3s |",
		"| Avg Indent Score | — | 0.90 |",
		"| Read | 10 | 0 |",
		`| Edit | ${overrides.editTotal ?? "5"} | 0 |`,
		"| Write | 2 | 0 |",
		"| Patch Failure Rate | 50.0% (5/10) |",
		"| Mutation Intent Match Rate | 66.0% |",
		"| Autocorrect-Free Success Rate | 80.0% |",
	].join("\n");
	await fs.writeFile(path.join(dir, name), `${report}\n`, "utf8");
}

function runScript(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: [process.execPath, SCRIPT_PATH, ...args],
		cwd: path.resolve(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
	};
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("eval-bench-runs", () => {
	it("parses comma-formatted counters and preserves verified percentages when aggregated", async () => {
		const firstDir = await makeTempDir();
		const secondDir = await makeTempDir();
		await writeReport(firstDir, "pipe__model-a.md");
		await writeReport(secondDir, "pipe__model-a.md", {
			totalRuns: "200",
			successfulRuns: "100",
			verifiedRate: "50.0% (50/100)",
		});
		const result = runScript([firstDir, secondDir, "--aggregate", "--format", "json"]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as Array<Record<string, number>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].totalRuns).toBe(1434);
		expect(parsed[0].successfulRuns).toBe(1100);
		expect(parsed[0].tasksAllPassing).toBe(2200);
		expect(parsed[0].tasksFlakyFailing).toBe(268);
		expect(parsed[0].timeoutRuns).toBe(24);
		expect(parsed[0].verifiedRuns).toBe(950);
		expect(parsed[0].verifiedAttempts).toBe(1300);
		expect(parsed[0].verifiedPct).toBeCloseTo((950 / 1300) * 100, 6);
	});

	it("aggregates edit-tool usage from counts instead of rounded row percentages", async () => {
		const firstDir = await makeTempDir();
		const secondDir = await makeTempDir();
		await writeReport(firstDir, "pipe__model-a.md", {
			totalRuns: "3",
			editToolUsageRate: "33.3% (1/3)",
			editTotal: "1",
		});
		await writeReport(secondDir, "pipe__model-a.md", {
			totalRuns: "3",
			editToolUsageRate: "33.3% (1/3)",
			editTotal: "1",
		});
		const result = runScript([firstDir, secondDir, "--aggregate", "--format", "json"]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as Array<Record<string, number>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].editTotal).toBe(2);
		expect(parsed[0].totalRuns).toBe(6);
		expect(parsed[0].editToolUsagePct).toBeCloseTo((2 / 6) * 100, 6);
	});

	it("sorts unknown separator slugs after known separators", async () => {
		const dir = await makeTempDir();
		await writeReport(dir, "zzz__model-a.md");
		await writeReport(dir, "pipe__model-a.md");
		const result = runScript([dir, "--sort", "sep", "--format", "json"]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as Array<Record<string, string>>;
		expect(parsed.map(row => row.sepSlug)).toEqual(["pipe", "zzz"]);
	});

	it("fails fast on invalid sort values", async () => {
		const dir = await makeTempDir();
		await writeReport(dir, "pipe__model-a.md");
		const result = runScript([dir, "--sort", "bogus", "--format", "json"]);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("invalid --sort value: bogus");
		expect(result.stderr).toContain("usage:");
	});

	it("fails fast on unknown options", async () => {
		const dir = await makeTempDir();
		await writeReport(dir, "pipe__model-a.md");
		const result = runScript([dir, "--formt", "json"]);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown option: --formt");
	});
});
