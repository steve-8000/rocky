import { describe, expect, test } from "bun:test";
import type { Model } from "@amaze/ai";
import { runDoctorConfigCommand } from "../../src/cli/doctor-config";
import { runDoctorContextCommand } from "../../src/cli/doctor-context";
import { runDoctorLocalLlmCommand } from "../../src/cli/doctor-local-llm";
import { runDoctorModelCommand } from "../../src/cli/doctor-model";
import { runDoctorSecurityCommand } from "../../src/cli/doctor-security";
import { Settings } from "../../src/config/settings";

const severities = new Set(["info", "low", "medium", "high", "critical"]);

function model(provider: string, id: string): Model<any> {
	return { provider, id, name: id, api: "openai-responses" } as Model<any>;
}

function registry(models: Model<any>[], authedProviders = new Set(models.map(item => item.provider))) {
	return {
		getAvailable: () => models,
		getApiKey: async (item: Model<any>) => (authedProviders.has(item.provider) ? "test-key" : undefined),
	} as never;
}

async function silenceStdout<T>(run: () => Promise<T>): Promise<T> {
	const originalWrite = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		return await run();
	} finally {
		process.stdout.write = originalWrite;
	}
}

function expectEnvelope(report: { status: string; findings: Array<{ severity: string }> }) {
	expect(["ok", "degraded", "failed"]).toContain(report.status);
	expect(Array.isArray(report.findings)).toBe(true);
	for (const finding of report.findings) expect(severities.has(finding.severity)).toBe(true);
}

describe("doctor envelopes", () => {
	test("security emits unified finding ids and severities", async () => {
		const settings = Settings.isolated({ "bash.safety.enabled": false });
		const original = Settings.createForCwd;
		Settings.createForCwd = (async () => settings) as typeof Settings.createForCwd;
		try {
			const report = await silenceStdout(() => runDoctorSecurityCommand());
			expectEnvelope(report);
			expect(report.findings.some(finding => finding.id === "SECURITY-BASH-DISABLED")).toBe(true);
		} finally {
			Settings.createForCwd = original;
		}
	});

	test("context maps warning and error vocabulary to unified severities", async () => {
		const report = await silenceStdout(() =>
			runDoctorContextCommand({
				settings: Settings.isolated({ "compaction.enabled": false, "localLlm.useForContextCompressor": true }),
			}),
		);
		expectEnvelope(report);
		expect(report.findings).toContainEqual(
			expect.objectContaining({ id: "CONTEXT-COMPACT-001", severity: "medium" }),
		);
	});

	test("model emits a finding when default role is unresolved", async () => {
		const models = [model("openai", "gpt-4o")];
		const report = await silenceStdout(() =>
			runDoctorModelCommand({
				settings: Settings.isolated({ modelRoles: {}, "task.agentModelOverrides": {} }),
				availableModels: models,
				modelRegistry: registry(models),
			}),
		);
		expectEnvelope(report);
		expect(report.findings).toContainEqual(
			expect.objectContaining({ id: "MODEL-DEFAULT-UNRESOLVED", severity: "high" }),
		);
	});

	test("local-llm emits a finding when required health fails", async () => {
		const report = await silenceStdout(() =>
			runDoctorLocalLlmCommand({
				settings: Settings.isolated({ "localLlm.enabled": true, "localLlm.required": true }),
				availableModels: [],
				modelRegistry: registry([]),
			}),
		);
		expectEnvelope(report);
		expect(report.findings).toContainEqual(
			expect.objectContaining({ id: "LOCAL-LLM-UNREACHABLE", severity: "high" }),
		);
	});

	test("config emits unified finding ids and severities", async () => {
		const report = await silenceStdout(() =>
			runDoctorConfigCommand({
				cwd: "/tmp/amaze-doctor-envelope-missing",
				homeDir: "/tmp/amaze-doctor-envelope-home",
			}),
		);
		expectEnvelope(report);
	});
});
