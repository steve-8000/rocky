/**
 * `amaze doctor context` — compaction / prompt-cache / local-llm coherence.
 *
 * Reports configuration relationships that are easy to confuse but intentionally
 * does not resolve models or mutate settings.
 */
import { Settings } from "../config/settings";
import type { DoctorFinding, DoctorReportBase } from "./doctor-types";

export type DoctorContextSeverity = "info" | "warning" | "error";

export interface DoctorContextReport extends DoctorReportBase {}

export interface DoctorContextOptions {
	json?: boolean;
	cwd?: string;
	settings?: Settings;
}

export async function runDoctorContextCommand(opts: DoctorContextOptions = {}): Promise<DoctorContextReport> {
	const settings = opts.settings ?? (await Settings.createForCwd(opts.cwd ?? process.cwd()));
	const findings = collectFindings(settings);
	const report: DoctorContextReport = {
		status: findings.some(finding => finding.severity === "high" || finding.severity === "critical")
			? "failed"
			: findings.some(finding => finding.severity === "medium")
				? "degraded"
				: "ok",
		findings,
	};

	process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : renderText(report));
	return report;
}

function collectFindings(settings: Settings): DoctorFinding[] {
	try {
		return collectConfiguredFindings(settings);
	} catch (error) {
		return [
			{
				id: "CONTEXT-ERROR",
				severity: "high",
				message: error instanceof Error ? error.message : String(error),
			},
		];
	}
}

function collectConfiguredFindings(settings: Settings): DoctorFinding[] {
	const mainContextMode = settings.get("prompt.mainContextMode");
	const compactionEnabled = settings.get("compaction.enabled");
	const findings: DoctorFinding[] = [
		{
			id: "CONTEXT-MODE-INFO",
			severity: "info",
			message: `prompt.mainContextMode=${mainContextMode} selects the main prompt template; compaction.enabled=${compactionEnabled} controls dynamic shrinking, so they are separate concepts.`,
		},
	];

	if (settings.get("localLlm.useForContextCompressor") && !compactionEnabled) {
		findings.push({
			id: "CONTEXT-COMPACT-001",
			severity: "medium",
			message:
				"localLlm context compressor is enabled but compaction is disabled — the compressor will never be invoked.",
		});
	}
	if (settings.get("compaction.idleEnabled") && !compactionEnabled) {
		findings.push({
			id: "CONTEXT-COMPACT-002",
			severity: "medium",
			message: "idle compaction is enabled but compaction itself is disabled.",
		});
	}
	if (
		settings.get("prompt.cache.orchestratorRetention") === "default" &&
		settings.get("prompt.cache.subagentRetention") === "short"
	) {
		findings.push({
			id: "CONTEXT-CACHE-INFO",
			severity: "info",
			message:
				"prompt.cache.orchestratorRetention=default keeps the orchestrator cache policy unchanged; prompt.cache.subagentRetention=short uses shorter-lived subagent cache retention.",
		});
	}
	findings.push({
		id: "CONTEXT-PROMOTION-INFO",
		severity: "info",
		message: `contextPromotion.enabled=${settings.get("contextPromotion.enabled")}.`,
	});
	return findings;
}

export function renderText(report: DoctorContextReport): string {
	const lines: string[] = ["Context doctor:"];
	if (report.findings.length === 0) {
		lines.push("  no findings");
	} else {
		for (const finding of report.findings) {
			lines.push(`  [${finding.severity}] ${finding.id}`);
			lines.push(`    ${finding.message}`);
		}
	}
	lines.push(`Status: ${report.status}`);
	return `${lines.join("\n")}\n`;
}
