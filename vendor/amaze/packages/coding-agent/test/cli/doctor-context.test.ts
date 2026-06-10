import { describe, expect, test } from "bun:test";
import { runDoctorContextCommand } from "../../src/cli/doctor-context";
import { Settings } from "../../src/config/settings";

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

describe("doctor context", () => {
	test("reports ok with informational findings only", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.idleEnabled": false,
			"localLlm.useForContextCompressor": false,
			"prompt.cache.orchestratorRetention": "default",
			"prompt.cache.subagentRetention": "default",
		});
		const { report, json } = await captureJson(() => runDoctorContextCommand({ json: true, settings }));

		expect(report.status).toBe("ok");
		expect(report.findings.every(finding => finding.severity === "info")).toBe(true);
		expect(json.status).toBe("ok");
	});

	test("reports CONTEXT-COMPACT-001 for localLlm compressor with compaction disabled", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.idleEnabled": false,
			"localLlm.useForContextCompressor": true,
		});
		const { report, json } = await captureJson(() => runDoctorContextCommand({ json: true, settings }));

		expect(report.status).toBe("degraded");
		expect(
			report.findings.some(finding => finding.id === "CONTEXT-COMPACT-001" && finding.severity === "medium"),
		).toBe(true);
		expect(json.findings.some((finding: { id: string }) => finding.id === "CONTEXT-COMPACT-001")).toBe(true);
	});

	test("reports failed when reading context settings throws", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"localLlm.useForContextCompressor": false,
		});
		const get = settings.get.bind(settings);
		settings.get = ((path: Parameters<typeof settings.get>[0]) => {
			if (path === "contextPromotion.enabled") throw new Error("boom");
			return get(path);
		}) as typeof settings.get;
		const { report, json } = await captureJson(() => runDoctorContextCommand({ json: true, settings }));

		expect(report.status).toBe("failed");
		expect(report.findings[0]).toMatchObject({ id: "CONTEXT-ERROR", severity: "high", message: "boom" });
		expect(json.status).toBe("failed");
	});
});
