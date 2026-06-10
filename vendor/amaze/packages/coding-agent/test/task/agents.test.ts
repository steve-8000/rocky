import { beforeEach, describe, expect, it } from "bun:test";
import { clearBundledAgentsCache, getBundledAgent, loadBundledAgents } from "../../src/task/agents";

describe("bundled agents", () => {
	beforeEach(() => {
		clearBundledAgentsCache();
	});

	it("loads the simplified bundled agent roster", () => {
		const agents = loadBundledAgents();
		const names = agents.map(agent => agent.name);

		expect(agents).toHaveLength(3);
		expect(names).toEqual(["Builder", "Resercher", "SRE"]);
	});

	it("registers Builder as the default delegated implementation agent", () => {
		const builder = getBundledAgent("Builder");
		if (!builder) throw new Error("Expected bundled Builder agent");

		expect(builder.model).toEqual(["Builder"]);
		expect(builder.spawns).toBe("*");
		expect(builder.description).toContain("not research-only and not SRE/operations");
		expect(builder.systemPrompt).toContain("worker agent for delegated tasks");
	});

	it("registers Resercher as the Codex Spark-backed search-only agent", () => {
		const researcher = getBundledAgent("Resercher");
		if (!researcher) throw new Error("Expected bundled Resercher agent");

		expect(researcher.model).toEqual(["Resercher"]);
		expect(researcher.tools?.filter(tool => tool !== "yield")).toEqual([
			"web_search",
			"x_search",
			"x_search_deep",
			"read",
			"browser",
		]);
		expect(researcher.description).toContain("GPT-5.3 Codex Spark search-only researcher");
	});

	it("registers SRE as the validator and deployment operations agent", () => {
		const sre = getBundledAgent("SRE");
		if (!sre) throw new Error("Expected bundled SRE agent");

		expect(sre.model).toEqual(["SRE"]);
		expect(sre.spawns).toBeUndefined();
		expect(sre.description).toContain("Validator operations");
	});
});
