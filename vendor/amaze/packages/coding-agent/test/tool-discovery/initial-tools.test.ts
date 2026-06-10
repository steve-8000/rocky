import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools/index";
import {
	AskTool,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	IrcTool,
	JobTool,
	RecipeTool,
	SshTool,
} from "../../src/tools/index";

function createAllToolsSettings(): Settings {
	return Settings.isolated({
		"astGrep.enabled": true,
		"astEdit.enabled": true,
		"renderMermaid.enabled": true,
		"debug.enabled": true,
		"find.enabled": true,
		"search.enabled": true,
		"github.enabled": true,
		"lsp.enabled": true,
		"inspect_image.enabled": true,
		"web_search.enabled": true,
		"calc.enabled": true,
		"browser.enabled": true,
		"checkpoint.enabled": true,
		"irc.enabled": true,
		"recipe.enabled": true,
		"todo.enabled": true,
		"tools.discoveryMode": "all",
		"agencyBrain.enabled": true,
	});
}

const allToolsSettings = createAllToolsSettings();
const toolSession: ToolSession = {
	cwd: "/tmp/test",
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: allToolsSettings,
	isToolDiscoveryEnabled: () => true,
	getSelectedDiscoveredToolNames: () => [],
	activateDiscoveredTools: async names => names,
};

async function getToolMetadata(): Promise<Map<string, { loadMode?: string; summary?: string }>> {
	const metadata = new Map<string, { loadMode?: string; summary?: string }>();
	const tools = await createTools({ ...toolSession, settings: createAllToolsSettings() }, Object.keys(BUILTIN_TOOLS));
	for (const tool of tools) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	for (const tool of [
		new AskTool({ ...toolSession, hasUI: true }),
		new SshTool(toolSession, [], new Map(), ""),
		new JobTool(toolSession),
		new RecipeTool(toolSession, []),
		new IrcTool(toolSession),
	]) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	return metadata;
}

describe("BUILTIN_TOOLS public factory map", () => {
	it("sets loading fields on tool definitions without wrapping factories", async () => {
		const metadata = await getToolMetadata();
		const missing = Object.keys(BUILTIN_TOOLS).filter(name => metadata.get(name)?.loadMode === undefined);
		expect(missing).toEqual([]);
	});
});

describe("built-in tool loadMode annotations", () => {
	it("provides a summary for every discoverable tool", async () => {
		const missing: string[] = [];
		const metadata = await getToolMetadata();
		for (const [name, meta] of metadata) {
			if (meta.loadMode === "discoverable" && !meta.summary) {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});
});

describe("computeEssentialBuiltinNames", () => {
	it("keeps read, find, search, edit, write, task, todo_write, and todo_read in the default essential set", () => {
		expect([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort()).toEqual([
			"edit",
			"find",
			"read",
			"search",
			"task",
			"todo_read",
			"todo_write",
			"write",
		]);
	});

	it("returns DEFAULT_ESSENTIAL_TOOL_NAMES when override is empty", () => {
		const settings = Settings.isolated({});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort());
	});

	it("respects tools.essentialOverride when provided", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "find"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["find", "read"]);
	});

	it("filters override entries that are not known built-in tools", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["read", "not_a_real_tool", "edit"],
		});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["edit", "read"]);
	});

	it("trims whitespace and drops empty entries from the override", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": [" read ", "", "  "],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual(["read"]);
	});

	it("returns an empty list when override is non-empty but contains only invalid names", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["not_a_real_tool"],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual([]);
	});
});

describe("tools.discoveryMode settings schema", () => {
	it("defaults to all for top-level lightweight orchestration", () => {
		const settings = Settings.isolated({});
		expect(settings.get("tools.discoveryMode")).toBe("all");
	});

	it("back-compat: mcp.discoveryMode still accepted", () => {
		const settings = Settings.isolated({ "mcp.discoveryMode": true });
		expect(settings.get("mcp.discoveryMode")).toBe(true);
	});
});
