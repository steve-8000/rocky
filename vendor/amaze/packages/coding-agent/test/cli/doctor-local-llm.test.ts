import { describe, expect, test } from "bun:test";
import type { Model } from "@amaze/ai";
import { runDoctorLocalLlmCommand } from "../../src/cli/doctor-local-llm";
import { Settings } from "../../src/config/settings";

function model(provider: string, id: string): Model<any> {
	return { provider, id, name: id, api: "openai-responses" } as Model<any>;
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

describe("doctor local-llm", () => {
	test("reports ok when disabled and not required", async () => {
		const settings = Settings.isolated({
			"localLlm.enabled": false,
			"localLlm.required": false,
		});
		const { report, json } = await captureJson(() => runDoctorLocalLlmCommand({ json: true, settings }));

		expect(report.status).toBe("ok");
		expect(report.health).toEqual({ ok: true, reason: "local-llm disabled and not required" });
		expect(json.health.ok).toBe(true);
	});

	test("reports degraded when enabled local-llm cannot resolve", async () => {
		const settings = Settings.isolated({
			"localLlm.enabled": true,
			"localLlm.required": false,
			"localLlm.modelRole": "Resercher",
			modelRoles: { Resercher: "openai/local" },
		});
		const { report, json } = await captureJson(() =>
			runDoctorLocalLlmCommand({ json: true, settings, availableModels: [] }),
		);

		expect(report.status).toBe("degraded");
		expect(report.health.ok).toBe(false);
		expect(json.status).toBe("degraded");
	});

	test("reports failed when required local-llm cannot resolve", async () => {
		const settings = Settings.isolated({
			"localLlm.enabled": true,
			"localLlm.required": true,
			"localLlm.modelRole": "Resercher",
			modelRoles: { Resercher: "openai/local" },
		});
		const { report, json } = await captureJson(() =>
			runDoctorLocalLlmCommand({ json: true, settings, availableModels: [] }),
		);

		expect(report.status).toBe("failed");
		expect(report.health.ok).toBe(false);
		expect(json.health.ok).toBe(false);
	});

	test("reports ok when enabled local-llm resolves", async () => {
		const local = model("openai", "local");
		const settings = Settings.isolated({
			"localLlm.enabled": true,
			"localLlm.required": true,
			"localLlm.modelRole": "Resercher",
			modelRoles: { Resercher: "openai/local" },
		});
		const { report, json } = await captureJson(() =>
			runDoctorLocalLlmCommand({ json: true, settings, availableModels: [local] }),
		);

		expect(report.status).toBe("ok");
		expect(report.health).toMatchObject({ ok: true, provider: "openai", model: "local" });
		expect(json.status).toBe("ok");
	});
});
