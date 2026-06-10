import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@amaze/utils";
import { runDoctorSecurityCommand } from "../../src/cli/doctor-security";

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

describe("doctor security", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = path.join(os.tmpdir(), "test-doctor-security", Snowflake.next(), "project");
		fs.mkdirSync(path.join(projectDir, ".amaze"), { recursive: true });
	});

	afterEach(() => {
		const parent = path.dirname(projectDir);
		if (fs.existsSync(parent)) fs.rmSync(parent, { recursive: true, force: true });
	});

	test("reports when MCP bash safety scope is disabled", async () => {
		fs.writeFileSync(
			path.join(projectDir, ".amaze", "config.yml"),
			"bash:\n  safety:\n    scope:\n      mcp: false\n",
		);

		const { report, json } = await captureJson(() => runDoctorSecurityCommand({ json: true, cwd: projectDir }));
		const finding = report.findings.find(f => f.id === "SECURITY-BASH-SCOPE-MCP-OFF");

		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("medium");
		expect(finding?.target).toBe("bash.safety.scope.mcp");
		expect(json.findings.some((f: { id: string }) => f.id === "SECURITY-BASH-SCOPE-MCP-OFF")).toBe(true);
	});

	test("reports when config command bash safety scope is disabled", async () => {
		fs.writeFileSync(
			path.join(projectDir, ".amaze", "config.yml"),
			"bash:\n  safety:\n    scope:\n      configCommand: false\n",
		);

		const { report, json } = await captureJson(() => runDoctorSecurityCommand({ json: true, cwd: projectDir }));
		const finding = report.findings.find(f => f.id === "SECURITY-BASH-SCOPE-CONFIGCMD-OFF");

		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("medium");
		expect(finding?.target).toBe("bash.safety.scope.configCommand");
		expect(json.findings.some((f: { id: string }) => f.id === "SECURITY-BASH-SCOPE-CONFIGCMD-OFF")).toBe(true);
	});
});
