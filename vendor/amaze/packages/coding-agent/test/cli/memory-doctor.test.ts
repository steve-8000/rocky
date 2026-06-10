import { describe, expect, it } from "bun:test";
import { getMemoryDoctorReport } from "../../src/cli/memory";

describe("memory doctor", () => {
	it("reports legacy local memory as removed", async () => {
		const report = await getMemoryDoctorReport();
		expect(report.backend).toBe("removed");
		expect(report.status).toBe("ok");
		expect(report.text).toBe(
			[
				"Memory backend: removed",
				"- Legacy local memory backends (Hermes/mem0) have been removed.",
				"- Supported memory: GBrain Agency Brain via MCP.",
			].join("\n"),
		);
	});
});
