/**
 * `amaze doctor security` — security-focused health checks.
 *
 * Checks configured bash safety posture, regex validity, plaintext secret risk
 * in local config files, and risky MCP stdio command surfaces.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { DoctorFinding, DoctorReportBase, DoctorSeverity, DoctorStatus } from "./doctor-types";

export type DoctorSecuritySeverity = DoctorSeverity;

export interface DoctorSecurityReport extends DoctorReportBase {}

export interface DoctorSecurityOptions {
	json?: boolean;
	cwd?: string;
}

const PLAINTEXT_SECRET_RE = /(api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/gi;

export async function runDoctorSecurityCommand(opts: DoctorSecurityOptions = {}): Promise<DoctorSecurityReport> {
	const cwd = opts.cwd ?? process.cwd();
	const findings: DoctorFinding[] = [];
	const settings = await Settings.createForCwd(cwd);

	if (settings.get("bash.safety.enabled") === false) {
		findings.push({
			id: "SECURITY-BASH-DISABLED",
			severity: "high",
			target: "bash.safety.enabled",
			message: "Bash safety policy is disabled.",
		});
	}
	if (settings.get("bash.safety.mode") === "off") {
		findings.push({
			id: "SECURITY-BASH-OFF",
			severity: "medium",
			target: "bash.safety.mode",
			message: "Bash safety policy mode is off.",
		});
	}

	if (settings.get("bash.safety.scope.mcp") === false) {
		findings.push({
			id: "SECURITY-BASH-SCOPE-MCP-OFF",
			severity: "medium",
			target: "bash.safety.scope.mcp",
			message: "MCP server spawn bypasses the bash safety policy. Risky MCP commands will not be blocked.",
			hint: "Set bash.safety.scope.mcp=true to restore the gate.",
		});
	}
	if (settings.get("bash.safety.scope.configCommand") === false) {
		findings.push({
			id: "SECURITY-BASH-SCOPE-CONFIGCMD-OFF",
			severity: "medium",
			target: "bash.safety.scope.configCommand",
			message:
				"!cmd config resolution bypasses the bash safety policy. Risky shell payloads in config will execute.",
			hint: "Set bash.safety.scope.configCommand=true to restore the gate.",
		});
	}

	for (const [setting, patterns] of [
		["bash.safety.denyPatterns", settings.get("bash.safety.denyPatterns")],
		["bash.safety.allowPatterns", settings.get("bash.safety.allowPatterns")],
	] as const) {
		for (const pattern of patterns) {
			try {
				new RegExp(pattern);
			} catch (error) {
				findings.push({
					id: "SECURITY-BASH-003",
					severity: "high",
					target: `${setting}: ${pattern}`,
					message: `Invalid bash safety regex: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	await scanSecretFile(path.join(cwd, ".amaze", "settings.json"), findings);
	await scanSecretFile(path.join(os.homedir(), ".amaze", "config.yml"), findings);
	await scanMcpConfig(path.join(cwd, ".mcp.json"), findings);

	const report: DoctorSecurityReport = {
		status: aggregateStatus(findings),
		findings,
	};

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
	} else {
		process.stdout.write(renderText(report));
	}
	return report;
}

async function scanSecretFile(filePath: string, findings: DoctorFinding[]): Promise<void> {
	const content = await readTextIfExists(filePath);
	if (content === undefined) return;
	PLAINTEXT_SECRET_RE.lastIndex = 0;
	for (const match of content.matchAll(PLAINTEXT_SECRET_RE)) {
		findings.push({
			id: "SECURITY-SECRET-001",
			severity: "critical",
			target: `${filePath}:${lineNumberForOffset(content, match.index ?? 0)}`,
			message: `Plaintext secret-like value found for ${match[1]}.`,
		});
	}
}

async function scanMcpConfig(filePath: string, findings: DoctorFinding[]): Promise<void> {
	const content = await readTextIfExists(filePath);
	if (content === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return;
	}
	for (const [name, entry] of enumerateMcpEntries(parsed)) {
		const command = typeof entry.command === "string" ? entry.command : "";
		const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		const commandLine = [command, ...args].filter(Boolean).join(" ");
		if (!isRiskyMcpCommand(command, commandLine)) continue;
		findings.push({
			id: "SECURITY-MCP-001",
			severity: "high",
			target: `.mcp.json:${name}`,
			message: `Risky MCP stdio command surface: ${commandLine || command}`,
		});
	}
}

function enumerateMcpEntries(parsed: unknown): Array<[string, { command?: unknown; args?: unknown }]> {
	if (!parsed || typeof parsed !== "object") return [];
	const root = parsed as Record<string, unknown>;
	const candidates = root.mcpServers && typeof root.mcpServers === "object" ? root.mcpServers : root;
	return Object.entries(candidates as Record<string, unknown>).flatMap(([name, value]) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		return [[name, value as { command?: unknown; args?: unknown }]];
	});
}

function isRiskyMcpCommand(command: string, commandLine: string): boolean {
	return (
		/\bnpx\s+-y\b/.test(commandLine) ||
		/^(?:sh|bash|curl|wget)$/.test(command) ||
		/[|]|&&/.test(command) ||
		/[|]|&&/.test(commandLine)
	);
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		return undefined;
	}
}

function lineNumberForOffset(text: string, offset: number): number {
	let line = 1;
	for (let idx = 0; idx < offset; idx++) {
		if (text.charCodeAt(idx) === 10) line++;
	}
	return line;
}

function aggregateStatus(findings: DoctorFinding[]): DoctorStatus {
	if (findings.some(finding => finding.severity === "critical")) return "failed";
	if (findings.some(finding => finding.severity === "high" || finding.severity === "medium")) return "degraded";
	return "ok";
}

export function renderText(report: DoctorSecurityReport): string {
	const lines: string[] = ["Security doctor:"];
	if (report.findings.length === 0) {
		lines.push("  no findings");
	} else {
		for (const finding of report.findings) {
			lines.push(`  [${finding.severity}] ${finding.id} — ${finding.target}`);
			lines.push(`    ${finding.message}`);
		}
	}
	lines.push(`Status: ${report.status}`);
	return `${lines.join("\n")}\n`;
}
