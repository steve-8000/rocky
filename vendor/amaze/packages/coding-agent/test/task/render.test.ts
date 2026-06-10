import { beforeAll, describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "../../src/extensibility/custom-tools/types";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import { renderResult } from "../../src/task/render";
import type { TaskToolDetails } from "../../src/task/types";

const renderOptions: RenderResultOptions = {
	expanded: false,
	isPartial: false,
	spinnerFrame: 0,
};

describe("task render", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("shows context window usage as percentage over the window", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "0-Explore",
					agent: "Explore",
					agentSource: "bundled",
					task: "Inspect code",
					exitCode: 0,
					output: "done",
					stderr: "",
					truncated: false,
					durationMs: 1200,
					tokens: 143000,
					contextTokens: 143000,
					contextWindow: 272000,
				},
			],
			totalDurationMs: 1200,
		};

		const component = renderResult({ content: [{ type: "text", text: "ok" }], details }, renderOptions, theme);
		const text = component.render(200).join("\n");
		expect(text).toContain("52.6%/272K");
		expect(text).toContain("Σ143K");
	});

	it("renders subagent memory notes from yield data", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "0-Review",
					agent: "Builder",
					agentSource: "bundled",
					task: "Review output",
					exitCode: 0,
					output: "done",
					stderr: "",
					truncated: false,
					durationMs: 500,
					tokens: 0,
					extractedToolData: {
						yield: [{ data: { ok: true }, status: "success", memoryNote: "Save the production hostname." }],
					},
				},
			],
			totalDurationMs: 500,
		};

		const component = renderResult({ content: [{ type: "text", text: "ok" }], details }, renderOptions, theme);
		const text = component.render(200).join("\n");
		expect(text).toContain("Memory note: Save the production hostname.");
	});
});
