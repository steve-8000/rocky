/**
 * `amaze doctor config` — surfaces project config-loader pitfalls.
 *
 * The settings loader only reads project-scope `.amaze/config.yml`; project-
 * scope `.amaze/settings.json` is intentionally ignored (see
 * `packages/coding-agent/test/settings-manager.test.ts` "always ignores project
 * .amaze/settings.json"). That decision is sound, but it means a user who
 * authors `.amaze/settings.json` gets silent config drop with no signal.
 *
 * This command surfaces the situation as actionable findings so the user can
 * migrate keys to YAML.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectAgentDir } from "@amaze/utils";
import { YAML } from "bun";
import type { DoctorFinding, DoctorReportBase, DoctorSeverity, DoctorStatus } from "./doctor-types";

export type DoctorConfigSeverity = Exclude<DoctorSeverity, "critical">;

export interface DoctorConfigReport extends DoctorReportBase {}

export interface DoctorConfigOptions {
	json?: boolean;
	cwd?: string;
	homeDir?: string;
}

export async function runDoctorConfigCommand(opts: DoctorConfigOptions = {}): Promise<DoctorConfigReport> {
	const cwd = opts.cwd ?? process.cwd();
	const homeDir = opts.homeDir ?? os.homedir();
	const findings: DoctorFinding[] = [];

	const projectAgentDir = getProjectAgentDir(cwd);
	const projectYmlPath = path.join(projectAgentDir, "config.yml");
	const projectJsonPath = path.join(projectAgentDir, "settings.json");
	const globalJsonPath = path.join(homeDir, ".amaze", "agent", "settings.json");

	const [ymlExists, jsonExists, globalJsonExists] = await Promise.all([
		fileExists(projectYmlPath),
		fileExists(projectJsonPath),
		fileExists(globalJsonPath),
	]);

	if (jsonExists && !ymlExists) {
		findings.push({
			id: "CONFIG-001",
			severity: "high",
			target: projectJsonPath,
			message:
				"Project .amaze/settings.json is silently ignored; the loader reads .amaze/config.yml at the project scope.",
			hint: "Convert keys to YAML in .amaze/config.yml, then delete settings.json.",
		});
	}

	if (jsonExists && ymlExists) {
		findings.push({
			id: "CONFIG-002",
			severity: "medium",
			target: projectJsonPath,
			message: ".amaze/settings.json exists alongside .amaze/config.yml; the JSON file is ignored by the loader.",
			hint: "Move any unique keys from settings.json into config.yml, then delete settings.json.",
		});
	}

	if (ymlExists) {
		const text = await readText(projectYmlPath);
		if (text !== undefined) {
			try {
				const parsed = YAML.parse(text);
				if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
					findings.push({
						id: "CONFIG-003",
						severity: "high",
						target: projectYmlPath,
						message: "Project config.yml does not parse as a YAML mapping.",
						hint: "Top-level value must be a mapping (key: value).",
					});
				}
			} catch (error) {
				findings.push({
					id: "CONFIG-003",
					severity: "high",
					target: projectYmlPath,
					message: `Project config.yml is malformed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	if (jsonExists) {
		const text = await readText(projectJsonPath);
		if (text !== undefined) {
			try {
				JSON.parse(text);
			} catch (error) {
				findings.push({
					id: "CONFIG-004",
					severity: "low",
					target: projectJsonPath,
					message: `Project settings.json is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
					hint: "The file is ignored regardless; fix only if you intend to migrate it.",
				});
			}
		}
	}

	if (globalJsonExists) {
		findings.push({
			id: "CONFIG-005",
			severity: "low",
			target: globalJsonPath,
			message:
				"Legacy ~/.amaze/agent/settings.json present; it will be migrated to config.yml on next Amaze launch.",
			hint: "Safe to leave; the file is renamed to settings.json.bak after migration.",
		});
	}

	const report: DoctorConfigReport = {
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

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch {
		return false;
	}
}

async function readText(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function aggregateStatus(findings: DoctorFinding[]): DoctorStatus {
	if (findings.some(finding => finding.severity === "high" || finding.severity === "medium")) {
		return "degraded";
	}
	return "ok";
}

export function renderText(report: DoctorConfigReport): string {
	const lines: string[] = ["Config doctor:"];
	if (report.findings.length === 0) {
		lines.push("  no findings");
	} else {
		for (const finding of report.findings) {
			lines.push(`  [${finding.severity}] ${finding.id} — ${finding.target}`);
			lines.push(`    ${finding.message}`);
			if (finding.hint) lines.push(`    hint: ${finding.hint}`);
		}
	}
	lines.push(`Status: ${report.status}`);
	return `${lines.join("\n")}\n`;
}
