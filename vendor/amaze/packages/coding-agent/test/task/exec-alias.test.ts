import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { resolveSubprocessToolNames } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";

function agentWithTools(tools: string[]): AgentDefinition {
	return {
		name: "test-agent",
		description: "test agent",
		systemPrompt: "test",
		source: "project",
		tools,
	};
}

describe("exec tool alias expansion", () => {
	it("maps exec to eval when eval.py is enabled without adding bash", () => {
		const tools = resolveSubprocessToolNames({
			agent: agentWithTools(["exec"]),
			settings: Settings.isolated({ "eval.py": true, "eval.js": false }),
			taskDepth: 0,
		});

		expect(tools).toContain("eval");
		expect(tools).not.toContain("bash");
	});

	it("keeps explicit bash and omits eval when both eval backends are disabled", () => {
		const tools = resolveSubprocessToolNames({
			agent: agentWithTools(["exec", "bash"]),
			settings: Settings.isolated({ "eval.py": false, "eval.js": false }),
			taskDepth: 0,
		});

		expect(tools).toContain("bash");
		expect(tools).not.toContain("eval");
	});

	it("leaves an empty tool list empty", () => {
		const tools = resolveSubprocessToolNames({
			agent: agentWithTools([]),
			settings: Settings.isolated(),
			taskDepth: 0,
		});

		expect(tools).toEqual([]);
	});

	it("returns undefined when the agent omits tools so the subprocess inherits the host registry", () => {
		const agent = {
			name: "test-agent",
			description: "test agent",
			prompt: "test",
			spawns: "*",
		} as unknown as AgentDefinition;
		const tools = resolveSubprocessToolNames({
			agent,
			settings: Settings.isolated(),
			taskDepth: 0,
		});

		expect(tools).toBeUndefined();
	});
});
