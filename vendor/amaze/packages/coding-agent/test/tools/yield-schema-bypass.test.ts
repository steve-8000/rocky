import { describe, expect, it } from "bun:test";
import { Settings } from "@amaze/coding-agent/config/settings";
import type { ToolSession } from "@amaze/coding-agent/tools";
import { YieldTool } from "@amaze/coding-agent/tools/yield";

function createSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		outputSchema: {
			type: "object",
			properties: {
				token: { type: "string", minLength: 3 },
			},
			required: ["token"],
		},
	};
}

const invalidYield = { result: { data: { token: "ab" } } } as never;

describe("YieldTool schema bypass policy", () => {
	it("rejects the second invalid yield by default", async () => {
		const tool = new YieldTool(createSession());

		await expect(tool.execute("default-1", invalidYield)).rejects.toThrow("Output does not match schema");
		await expect(tool.execute("default-2", invalidYield)).rejects.toThrow("Output does not match schema");
	});

	it("allows schema bypass after one failure when explicitly enabled", async () => {
		const tool = new YieldTool(createSession(Settings.isolated({ "task.yield.allowSchemaBypass": true })));

		await expect(tool.execute("enabled-1", invalidYield)).rejects.toThrow("Output does not match schema");
		const result = await tool.execute("enabled-2", invalidYield);

		expect(result.details).toEqual({ data: { token: "ab" }, status: "success", error: undefined });
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Result submitted (schema validation overridden after 2 failed attempt(s)).",
			},
		]);
	});
});
