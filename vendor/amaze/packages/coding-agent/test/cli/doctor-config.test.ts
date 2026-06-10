import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@amaze/utils";
import { runDoctorConfigCommand } from "../../src/cli/doctor-config";

async function captureJson<T>(run: () => Promise<T>): Promise<{ report: T; json: any }> {
	let stdout = "";
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	try {
		const report = await run();
		return { report, json: JSON.parse(stdout) };
	} finally {
		process.stdout.write = originalWrite;
	}
}

describe("doctor config", () => {
	let projectDir: string;
	let homeDir: string;

	beforeEach(() => {
		const tmp = path.join(os.tmpdir(), "test-doctor-config", Snowflake.next());
		projectDir = path.join(tmp, "project");
		homeDir = path.join(tmp, "home");
		fs.mkdirSync(path.join(projectDir, ".amaze"), { recursive: true });
		fs.mkdirSync(path.join(homeDir, ".amaze", "agent"), { recursive: true });
	});

	afterEach(() => {
		const parents = [path.dirname(projectDir)];
		for (const dir of parents) {
			if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("clean project (no project config) reports ok", async () => {
		const { report, json } = await captureJson(() =>
			runDoctorConfigCommand({ json: true, cwd: projectDir, homeDir }),
		);
		expect(report.status).toBe("ok");
		expect(report.findings).toEqual([]);
		expect(json.status).toBe("ok");
	});

	test("CONFIG-001: project settings.json without config.yml flags high severity", async () => {
		fs.writeFileSync(
			path.join(projectDir, ".amaze", "settings.json"),
			JSON.stringify({ compaction: { enabled: false } }),
		);
		const { report } = await captureJson(() => runDoctorConfigCommand({ json: true, cwd: projectDir, homeDir }));
		expect(report.status).toBe("degraded");
		const finding = report.findings.find(f => f.id === "CONFIG-001");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("high");
		expect(finding?.hint).toContain("config.yml");
	});

	test("CONFIG-002: both files present flags medium and ignores JSON", async () => {
		fs.writeFileSync(path.join(projectDir, ".amaze", "config.yml"), "shellPath: /bin/zsh\n");
		fs.writeFileSync(path.join(projectDir, ".amaze", "settings.json"), JSON.stringify({ shellPath: "/bin/bash" }));
		const { report } = await captureJson(() => runDoctorConfigCommand({ json: true, cwd: projectDir, homeDir }));
		expect(report.status).toBe("degraded");
		const finding = report.findings.find(f => f.id === "CONFIG-002");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("medium");
		// CONFIG-001 should NOT fire when config.yml exists.
		expect(report.findings.find(f => f.id === "CONFIG-001")).toBeUndefined();
	});

	test("CONFIG-003: malformed YAML is flagged high", async () => {
		fs.writeFileSync(
			path.join(projectDir, ".amaze", "config.yml"),
			"shellPath: /bin/zsh\n  invalid:\n indent: bad\n",
		);
		const { report } = await captureJson(() => runDoctorConfigCommand({ json: true, cwd: projectDir, homeDir }));
		const finding = report.findings.find(f => f.id === "CONFIG-003");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("high");
		expect(report.status).toBe("degraded");
	});

	test("CONFIG-004: malformed JSON in settings.json is low", async () => {
		fs.writeFileSync(path.join(projectDir, ".amaze", "settings.json"), "{not valid json");
		const { report } = await captureJson(() => runDoctorConfigCommand({ json: true, cwd: projectDir, homeDir }));
		const finding = report.findings.find(f => f.id === "CONFIG-004");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("low");
	});

	test("CONFIG-005: legacy global settings.json surfaces info-grade advisory", async () => {
		fs.writeFileSync(path.join(homeDir, ".amaze", "agent", "settings.json"), JSON.stringify({ theme: "dark" }));
		const { report } = await captureJson(() => runDoctorConfigCommand({ json: true, cwd: projectDir, homeDir }));
		const finding = report.findings.find(f => f.id === "CONFIG-005");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("low");
		// Low alone keeps status ok.
		expect(report.status).toBe("ok");
	});

	test("project config.yml only (canonical) reports ok", async () => {
		fs.writeFileSync(
			path.join(projectDir, ".amaze", "config.yml"),
			"shellPath: /bin/zsh\ncompaction:\n  enabled: false\n",
		);
		const { report } = await captureJson(() => runDoctorConfigCommand({ json: true, cwd: projectDir, homeDir }));
		expect(report.status).toBe("ok");
		expect(report.findings).toEqual([]);
	});

	test("text output renders findings deterministically", async () => {
		fs.writeFileSync(path.join(projectDir, ".amaze", "settings.json"), JSON.stringify({ shellPath: "/bin/bash" }));
		let stdout = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout += chunk.toString();
			return true;
		}) as typeof process.stdout.write;
		try {
			await runDoctorConfigCommand({ cwd: projectDir, homeDir });
		} finally {
			process.stdout.write = originalWrite;
		}
		expect(stdout).toContain("Config doctor:");
		expect(stdout).toContain("CONFIG-001");
		expect(stdout).toContain("Status: degraded");
	});
});
