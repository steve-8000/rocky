import { describe, expect, test } from "bun:test";
import type { Model } from "@amaze/ai";
import { runDoctorModelCommand } from "../../src/cli/doctor-model";
import { Settings } from "../../src/config/settings";

function model(provider: string, id: string): Model<any> {
	return { provider, id, name: id, api: "openai-responses" } as Model<any>;
}

function registry(models: Model<any>[], authedProviders = new Set(models.map(item => item.provider))) {
	return {
		getAvailable: () => models,
		getApiKey: async (item: Model<any>) => (authedProviders.has(item.provider) ? "test-key" : undefined),
	} as never;
}

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

describe("doctor model", () => {
	test("reports ok when default role and overrides resolve", async () => {
		const models = [model("openai", "gpt-4o"), model("anthropic", "claude")];
		const settings = Settings.isolated({
			modelRoles: { default: "openai/gpt-4o" },
			"task.agentModelOverrides": { Builder: "anthropic/claude" },
		});
		const { report, json } = await captureJson(() =>
			runDoctorModelCommand({ json: true, settings, availableModels: models, modelRegistry: registry(models) }),
		);

		expect(report.status).toBe("ok");
		expect(report.defaultRole).toMatchObject({
			role: "default",
			resolved: true,
			provider: "openai",
			model: "gpt-4o",
		});
		expect(report.overrides).toHaveLength(1);
		expect(json.status).toBe("ok");
	});

	test("reports degraded when an override cannot resolve", async () => {
		const models = [model("openai", "gpt-4o")];
		const settings = Settings.isolated({
			modelRoles: { default: "openai/gpt-4o" },
			"task.agentModelOverrides": { Builder: "anthropic/claude" },
		});
		const { report, json } = await captureJson(() =>
			runDoctorModelCommand({ json: true, settings, availableModels: models, modelRegistry: registry(models) }),
		);

		expect(report.status).toBe("degraded");
		expect(report.overrides[0]).toMatchObject({ role: "Builder", resolved: false });
		expect(json.overrides[0].resolved).toBe(false);
	});

	test("reports failed when modelRoles.default is not set", async () => {
		const models = [model("openai", "gpt-4o")];
		const settings = Settings.isolated({ modelRoles: {}, "task.agentModelOverrides": {} });
		const { report, json } = await captureJson(() =>
			runDoctorModelCommand({ json: true, settings, availableModels: models, modelRegistry: registry(models) }),
		);

		expect(report.status).toBe("failed");
		expect(report.defaultRole).toEqual({ role: "default", resolved: false, error: "modelRoles.default not set" });
		expect(json.defaultRole.error).toBe("modelRoles.default not set");
	});
});
