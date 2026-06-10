/**
 * `amaze doctor model` — modelRoles + agent overrides + provider availability.
 *
 * Uses the existing model resolver against the currently available model list. The
 * doctor intentionally stops at resolver/auth availability instead of reproducing
 * fallback-chain selection logic, so failures point at the role or override value
 * the user configured.
 */
import type { Api, Model } from "@amaze/ai";
import { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
import { type SettingPath, Settings } from "../config/settings";
import { AuthStorage } from "../session/auth-storage";
import type { DoctorFinding, DoctorReportBase } from "./doctor-types";

export interface DoctorModelRoleStatus {
	role: string;
	resolved: boolean;
	provider?: string;
	model?: string;
	error?: string;
}

export interface DoctorModelReport extends DoctorReportBase {
	defaultRole: DoctorModelRoleStatus;
	overrides: DoctorModelRoleStatus[];
	details: {
		defaultRole: DoctorModelRoleStatus;
		overrides: DoctorModelRoleStatus[];
	};
}

export interface DoctorModelOptions {
	cwd?: string;
	json?: boolean;
	settings?: Settings;
	availableModels?: Model<Api>[];
	modelRegistry?: Pick<ModelRegistry, "getAvailable" | "getApiKey" | "getCanonicalVariants" | "resolveCanonicalModel">;
}

export async function runDoctorModelCommand(opts: DoctorModelOptions = {}): Promise<DoctorModelReport> {
	const settings = opts.settings ?? (await Settings.createForCwd(opts.cwd ?? process.cwd()));
	const modelRegistry = opts.modelRegistry ?? (await createModelRegistry());
	const availableModels = opts.availableModels ?? modelRegistry.getAvailable();
	const defaultRole = await resolveConfiguredRole(
		"default",
		settings.getModelRole("default"),
		settings,
		availableModels,
		modelRegistry,
	);
	const overrides = await Promise.all(
		Object.entries(getSetting<Record<string, string>>(settings, "task.agentModelOverrides", {})).map(
			([role, value]) => resolveConfiguredRole(role, value, settings, availableModels, modelRegistry),
		),
	);
	const findings = collectFindings(defaultRole, overrides);
	const report: DoctorModelReport = {
		status: !defaultRole.resolved ? "failed" : overrides.some(override => !override.resolved) ? "degraded" : "ok",
		findings,
		defaultRole,
		overrides,
		details: { defaultRole, overrides },
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

async function resolveConfiguredRole(
	role: string,
	value: string | undefined,
	settings: Settings,
	availableModels: Model<Api>[],
	modelRegistry: DoctorModelOptions["modelRegistry"],
): Promise<DoctorModelRoleStatus> {
	if (!value?.trim()) {
		return {
			role,
			resolved: false,
			error: role === "default" ? "modelRoles.default not set" : "model override not set",
		};
	}
	const resolved = resolveModelRoleValue(value, availableModels, { settings, modelRegistry });
	const model = resolved.model;
	if (!model) {
		return { role, resolved: false, error: resolved.warning ?? `No available model resolved for ${value}` };
	}
	const apiKey = await modelRegistry?.getApiKey?.(model);
	if (!apiKey) {
		return {
			role,
			resolved: false,
			provider: model.provider,
			model: model.id,
			error: `No auth available for ${model.provider}`,
		};
	}
	return { role, resolved: true, provider: model.provider, model: model.id };
}

function collectFindings(defaultRole: DoctorModelRoleStatus, overrides: DoctorModelRoleStatus[]): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	if (!defaultRole.resolved) {
		findings.push({
			id: "MODEL-DEFAULT-UNRESOLVED",
			severity: "high",
			target: "modelRoles.default",
			message: defaultRole.error ?? "Default model role could not be resolved.",
			meta: { defaultRole },
		});
	}
	for (const override of overrides) {
		if (override.resolved) continue;
		findings.push({
			id: "MODEL-OVERRIDE-UNRESOLVED",
			severity: "medium",
			target: `task.agentModelOverrides.${override.role}`,
			message: override.error ?? `Model override ${override.role} could not be resolved.`,
			meta: { override },
		});
	}
	return findings;
}

function getSetting<T>(settings: Settings, path: SettingPath, fallback: T): T {
	try {
		return settings.get(path) as T;
	} catch {
		return fallback;
	}
}

export function renderText(report: DoctorModelReport): string {
	const lines: string[] = ["Model doctor:"];
	lines.push(`  default: ${formatRole(report.defaultRole)}`);
	if (report.overrides.length === 0) {
		lines.push("  overrides: none");
	} else {
		lines.push("  overrides:");
		for (const override of report.overrides) {
			lines.push(`    - ${formatRole(override)}`);
		}
	}
	lines.push(`Status: ${report.status}`);
	return `${lines.join("\n")}\n`;
}

function formatRole(status: DoctorModelRoleStatus): string {
	if (!status.resolved) return `${status.role} ✗ ${status.error ?? "unresolved"}`;
	const provider = status.provider ?? "?";
	const model = status.model ?? "?";
	return `${status.role} → ${provider}/${model}`;
}
