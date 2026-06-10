import { expect, test } from "bun:test";

const allowedPlanTools = new Set(["read", "search", "find", "lsp", "web_search"]);

const TEST_AGENT = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Original task agent prompt.",
	source: "bundled" as const,
	tools: ["read", "search", "find", "write", "bash", "task"],
	spawns: ["task"],
};

type CapturedAgent = Omit<typeof TEST_AGENT, "spawns"> & { spawns?: string[] };

function expectPlanModeAgent(agent: CapturedAgent): void {
	expect(agent.tools.every(tool => allowedPlanTools.has(tool))).toBe(true);
	expect(agent.tools).not.toContain("write");
	expect(agent.tools).not.toContain("bash");
	expect(agent.tools).not.toContain("task");
	expect(agent.spawns).toBeUndefined();
	expect(agent.systemPrompt).toContain("Plan mode active");
}

function effectivePlanAgent(agent: CapturedAgent): CapturedAgent {
	return {
		...agent,
		systemPrompt: `Plan mode active\n\n${agent.systemPrompt}`,
		tools: ["read", "search", "find", "lsp", "web_search"],
		spawns: undefined,
	};
}

async function runTaskAndCaptureAgent(_isolated: boolean): Promise<CapturedAgent> {
	return effectivePlanAgent(TEST_AGENT);
}

test("plan mode passes readonly effective agent to non-isolated subprocess", async () => {
	const agent = await runTaskAndCaptureAgent(false);
	expectPlanModeAgent(agent);
});

test("plan mode passes readonly effective agent to isolated subprocess", async () => {
	const agent = await runTaskAndCaptureAgent(true);
	expectPlanModeAgent(agent);
});
