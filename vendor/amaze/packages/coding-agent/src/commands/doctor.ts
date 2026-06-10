/**
 * Aggregate health checks across memory, metrics, rules, and observability,
 * plus focused subcommands for security / model / context / local-llm.
 *
 * Subcommand surface:
 *   amaze doctor                — legacy aggregate report (default)
 *   amaze doctor security       — bash policy, settings, MCP/secret scan
 *   amaze doctor model          — modelRoles + agent overrides resolvability
 *   amaze doctor context        — compaction / prompt-cache / local-llm coherence
 *   amaze doctor local-llm      — local LLM health
 *   amaze doctor config         — project config-loader sanity (.yml vs legacy .json)
 *
 * Each subcommand sets a non-zero exit code when its status is not `ok`,
 * matching the legacy aggregate behaviour.
 */
import { Args, Command, Flags } from "@amaze/utils/cli";
import { type DoctorReport, renderText as renderLegacyText, runDoctorCommand } from "../cli/doctor";
import type { DoctorFinding, DoctorReportBase, DoctorStatus } from "../cli/doctor-types";
import { isSettingsInitialized, Settings } from "../config/settings";

const ACTIONS = ["all", "security", "model", "context", "local-llm", "config"] as const;
type DoctorAction = (typeof ACTIONS)[number];
const AGGREGATE_ACTIONS = ["legacy", "security", "model", "context", "local-llm", "config"] as const;
type AggregateAction = (typeof AGGREGATE_ACTIONS)[number];

export default class Doctor extends Command {
	static description = "Run health checks across Amaze subsystems";

	static args = {
		action: Args.string({
			description: "Doctor subcommand (defaults to legacy aggregate)",
			required: false,
			options: [...ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Emit a single JSON health report" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Doctor);
		const action = (args.action ?? "legacy") as DoctorAction | "legacy";
		const json = flags.json;

		switch (action) {
			case "all": {
				const report = await runAggregateDoctorCommand({ json });
				if (report.status !== "ok") process.exitCode = 1;
				return;
			}
			case "legacy": {
				const report = await runDoctorCommand({ json });
				if (report.status !== "ok") process.exitCode = 1;
				return;
			}
			case "security": {
				const { runDoctorSecurityCommand } = await import("../cli/doctor-security");
				const report = await runDoctorSecurityCommand({ json });
				if (report.status !== "ok") process.exitCode = 1;
				return;
			}
			case "model": {
				const { runDoctorModelCommand } = await import("../cli/doctor-model");
				const report = await runDoctorModelCommand({ json });
				if (report.status !== "ok") process.exitCode = 1;
				return;
			}
			case "context": {
				const { runDoctorContextCommand } = await import("../cli/doctor-context");
				const report = await runDoctorContextCommand({ json });
				if (report.status !== "ok") process.exitCode = 1;
				return;
			}
			case "local-llm": {
				const { runDoctorLocalLlmCommand } = await import("../cli/doctor-local-llm");
				const report = await runDoctorLocalLlmCommand({ json });
				if (report.status !== "ok") process.exitCode = 1;
				return;
			}
			case "config": {
				const { runDoctorConfigCommand } = await import("../cli/doctor-config");
				const report = await runDoctorConfigCommand({ json });
				if (report.status !== "ok") process.exitCode = 1;
				return;
			}
			default: {
				const exhaustive: never = action as never;
				throw new Error(`Unknown doctor action: ${String(exhaustive)}`);
			}
		}
	}
}

interface DoctorAggregateReport extends DoctorReportBase {
	perAction: Partial<Record<AggregateAction, unknown>>;
}

async function runAggregateDoctorCommand(opts: { json?: boolean } = {}): Promise<DoctorAggregateReport> {
	const settings = isSettingsInitialized() ? Settings.instance : await Settings.init();
	const configuredActions: readonly string[] = (settings.get("doctor.all.actions") ?? []) as readonly string[];
	const unknownActions = configuredActions.filter(action => !isAggregateAction(action));
	if (unknownActions.length > 0) {
		console.warn(`Unknown doctor.all.actions entries ignored: ${unknownActions.join(", ")}`);
	}
	const enabled = AGGREGATE_ACTIONS.filter(action => configuredActions.includes(action));
	const findings: DoctorFinding[] = [];
	const perAction: Partial<Record<AggregateAction, unknown>> = {};
	const textSections: string[] = [];

	for (const action of enabled) {
		switch (action) {
			case "legacy": {
				const report = await captureStdout(() => runDoctorCommand({ json: false }));
				perAction.legacy = report;
				if (report.status !== "ok") {
					findings.push({
						id: report.status === "failed" ? "LEGACY-FAILED" : "LEGACY-DEGRADED",
						severity: report.status === "failed" ? "high" : "medium",
						target: "legacy",
						message: `Legacy doctor status is ${report.status}.`,
						meta: { details: { legacy: report } },
					});
				}
				textSections.push(renderLegacyText(report));
				break;
			}
			case "security": {
				const { renderText, runDoctorSecurityCommand } = await import("../cli/doctor-security");
				const report = await captureStdout(() => runDoctorSecurityCommand({ json: false }));
				perAction.security = report;
				findings.push(...report.findings);
				textSections.push(renderText(report));
				break;
			}
			case "model": {
				const { renderText, runDoctorModelCommand } = await import("../cli/doctor-model");
				const report = await captureStdout(() => runDoctorModelCommand({ json: false }));
				perAction.model = report;
				findings.push(...report.findings);
				textSections.push(renderText(report));
				break;
			}
			case "context": {
				const { renderText, runDoctorContextCommand } = await import("../cli/doctor-context");
				const report = await captureStdout(() => runDoctorContextCommand({ json: false }));
				perAction.context = report;
				findings.push(...report.findings);
				textSections.push(renderText(report));
				break;
			}
			case "local-llm": {
				const { renderText, runDoctorLocalLlmCommand } = await import("../cli/doctor-local-llm");
				const report = await captureStdout(() => runDoctorLocalLlmCommand({ json: false }));
				perAction["local-llm"] = report;
				findings.push(...report.findings);
				textSections.push(renderText(report));
				break;
			}
			case "config": {
				const { renderText, runDoctorConfigCommand } = await import("../cli/doctor-config");
				const report = await captureStdout(() => runDoctorConfigCommand({ json: false }));
				perAction.config = report;
				findings.push(...report.findings);
				textSections.push(renderText(report));
				break;
			}
		}
	}

	const subreports = Object.values(perAction).filter(isReport);
	const status = aggregateStatus(findings, subreports);
	const report: DoctorAggregateReport = { status, findings, perAction };
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
	} else {
		if (textSections.length > 0) process.stdout.write(textSections.join("\n"));
		process.stdout.write(`Aggregate status: ${status}\n`);
	}
	return report;
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<T> {
	const originalWrite = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		return await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
}

function isAggregateAction(action: string): action is AggregateAction {
	return (AGGREGATE_ACTIONS as readonly string[]).includes(action);
}

function isReport(value: unknown): value is DoctorReportBase | DoctorReport {
	return !!value && typeof value === "object" && "status" in value;
}

function aggregateStatus(findings: DoctorFinding[], reports: Array<DoctorReportBase | DoctorReport>): DoctorStatus {
	if (
		reports.some(report => report.status === "failed") ||
		findings.some(finding => finding.severity === "critical")
	) {
		return "failed";
	}
	if (findings.some(finding => finding.severity === "medium" || finding.severity === "high")) return "degraded";
	return "ok";
}
