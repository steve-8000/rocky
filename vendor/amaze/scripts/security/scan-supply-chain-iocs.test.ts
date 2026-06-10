import { describe, expect, test } from "bun:test";
import { collectTargetFiles, scanForFindings } from "./scan-supply-chain-iocs";

function rulesFor(input: string, fileName: string): string[] {
	return scanForFindings(input, fileName).map((finding) => finding.rule);
}

describe("scan-supply-chain-iocs", () => {
	test("detects hardcoded API key prefixes anywhere", () => {
		const findings = scanForFindings("OPENAI=sk-abcdefghijklmnopqrstuvwxyz", ".amaze/settings.json");

		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ rule: "IOC-SECRET-001", severity: "critical", line: 1 });
	});

	test("detects hardcoded credential assignments in structured config", () => {
		const findings = scanForFindings('{ "api_key": "abcdefghijklmnop" }', ".amaze/settings.json");

		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ rule: "IOC-SECRET-002", severity: "high" });
	});

	test("does not flag command, env, or placeholder credential references", () => {
		const input = [
			'{ "api_key": "!cmd op read item" }',
			'{ "token": "${TOKEN_FROM_ENV}" }',
			'{ "password": "<insert-token-here>" }',
		].join("\n");

		expect(rulesFor(input, ".amaze/settings.json")).not.toContain("IOC-SECRET-002");
	});

	test("detects risky MCP shell and downloader commands", () => {
		const input = JSON.stringify({
			mcpServers: {
				shell: { command: "bash", args: ["-lc", "echo hi"] },
				download: { command: "curl", args: ["https://example.invalid/install.sh"] },
				inline: { command: "node", args: ["-c", "whoami"] },
			},
		});

		expect(rulesFor(input, ".mcp.json").filter((rule) => rule === "IOC-MCP-001")).toHaveLength(3);
	});

	test("detects MCP auto-install commands", () => {
		const input = JSON.stringify({ mcpServers: { remote: { command: "npx", args: ["-y", "some-server"] } } });

		expect(scanForFindings(input, ".mcp.json")[0]).toMatchObject({ rule: "IOC-MCP-002", severity: "medium" });
	});

	test("collapses duplicate bun.lock dependency versions into a single finding", () => {
		const input = [
			'    "left-pad@1.0.0":',
			'    "left-pad@1.1.0":',
			'    "left-pad@1.1.0":',
			'    "other@2.0.0":',
		].join("\n");

		const findings = scanForFindings(input, "bun.lock").filter((finding) => finding.rule === "IOC-DEP-001");

		expect(findings).toHaveLength(1);
		expect(findings[0]?.evidence).toBe("left-pad: 1.0.0, 1.1.0");
	});

	test("detects non-HTTPS dependency URLs in package manifests", () => {
		const input = JSON.stringify({
			dependencies: { unsafe: "http://example.invalid/pkg.tgz" },
			devDependencies: { ssh: "git+ssh://git@example.invalid/repo.git" },
		});

		const findings = scanForFindings(input, "package.json").filter((finding) => finding.rule === "IOC-DEP-002");

		expect(findings).toHaveLength(2);
		expect(findings.every((finding) => finding.severity === "low")).toBe(true);
	});

	test("accepts CI workflow and install/release script files as scanner inputs", () => {
		const inputs = [
			['token: "hardcoded-secret-value"', ".github/workflows/ci.yml"],
			["OPENAI=sk-abcdefghijklmnopqrstuvwxyz", "scripts/install.sh"],
			["const token = 'sk-abcdefghijklmnopqrstuvwxyz';", "scripts/release.ts"],
		] as const;

		for (const [input, fileName] of inputs) {
			expect(rulesFor(input, fileName)).toContain(fileName.endsWith(".yml") ? "IOC-SECRET-002" : "IOC-SECRET-001");
		}
	});

	test("collects CI workflows and install/release scripts for CLI scans", async () => {
		const files = await collectTargetFiles(".");

		expect(files).toContain(".github/workflows/ci.yml");
		expect(files).toContain("scripts/install.sh");
		expect(files).toContain("scripts/release.ts");
	});
});
