/**
 * `amaze doctor local-llm` — local LLM health.
 *
 * Reuses the local-llm health resolver and adapts its availability report to the
 * doctor subcommand's status model.
 */
import type { Api, Model } from "@amaze/ai";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { resolveLocalLlmHealth } from "../local-llm/health-check";
import { AuthStorage } from "../session/auth-storage";
import type { DoctorFinding, DoctorReportBase } from "./doctor-types";

export interface DoctorLocalLlmHealth {
	ok: boolean;
	provider?: string;
	model?: string;
	reason?: string;
}

export interface DoctorLocalLlmReport extends DoctorReportBase {
	enabled: boolean;
	required: boolean;
	health: DoctorLocalLlmHealth;
	details: {
		enabled: boolean;
		required: boolean;
		health: DoctorLocalLlmHealth;
	};
}

export interface DoctorLocalLlmOptions {
	json?: boolean;
	cwd?: string;
	settings?: Settings;
	availableModels?: Model<Api>[];
	modelRegistry?: ModelRegistry;
}

export async function runDoctorLocalLlmCommand(opts: DoctorLocalLlmOptions = {}): Promise<DoctorLocalLlmReport> {
	const settings = opts.settings ?? (await Settings.createForCwd(opts.cwd ?? process.cwd()));
	const enabled = settings.get("localLlm.enabled");
	const required = settings.get("localLlm.required");
	const modelRegistry = opts.modelRegistry ?? (enabled ? await createModelRegistry() : undefined);
	const availableModels = opts.availableModels ?? modelRegistry?.getAvailable() ?? [];
	const health = resolveDoctorLocalLlmHealth(settings, enabled, required, availableModels, modelRegistry);
	const findings = collectFindings(enabled, required, health);
	const report: DoctorLocalLlmReport = {
		status: required && !health.ok ? "failed" : enabled && !health.ok ? "degraded" : "ok",
		findings,
		enabled,
		required,
		health,
		details: { enabled, required, health },
	};

	process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : renderText(report));
	return report;
}

async function createModelRegistry(): Promise<ModelRegistry> {
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh("online-if-uncached");
	return modelRegistry;
}

function resolveDoctorLocalLlmHealth(
	settings: Settings,
	enabled: boolean,
	required: boolean,
	availableModels: Model<Api>[],
	modelRegistry: ModelRegistry | undefined,
): DoctorLocalLlmHealth {
	if (!enabled && !required) return { ok: true, reason: "local-llm disabled and not required" };
	const health = resolveLocalLlmHealth({ settings, availableModels, modelRegistry });
	return {
		ok: health.available,
		provider: health.provider,
		model: health.model,
		reason: health.available ? undefined : health.reason,
	};
}

function collectFindings(enabled: boolean, required: boolean, health: DoctorLocalLlmHealth): DoctorFinding[] {
	if (health.ok) return [];
	return [
		{
			id: enabled || required ? "LOCAL-LLM-UNREACHABLE" : "LOCAL-LLM-DISABLED",
			severity: required ? "high" : "medium",
			target: "localLlm",
			message: health.reason ?? "Local LLM health check failed.",
			meta: { enabled, required, health },
		},
	];
}

export function renderText(report: DoctorLocalLlmReport): string {
	const lines: string[] = ["Local-LLM doctor:"];
	lines.push(`  enabled: ${report.enabled}`);
	lines.push(`  required: ${report.required}`);
	const health = report.health;
	if (health.ok) {
		lines.push(`  health: ok${health.provider ? ` (${health.provider}/${health.model ?? "?"})` : ""}`);
	} else {
		lines.push(`  health: ✗ ${health.reason ?? "unknown"}`);
	}
	lines.push(`Status: ${report.status}`);
	return `${lines.join("\n")}\n`;
}
