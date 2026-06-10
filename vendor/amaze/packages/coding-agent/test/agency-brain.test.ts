import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@amaze/agent-core";
import * as z from "zod/v4";
import { parseAgencyAgentRegistryPage } from "../src/agency-brain";
import { Settings } from "../src/config/settings";
import { createMCPToolName } from "../src/mcp/tool-bridge";
import { AgencyBrainQueryTool, AgencyBrainRegistryTool, createTools, type ToolSession } from "../src/tools";

describe("parseAgencyAgentRegistryPage", () => {
	it("parses a valid frontmatter registry", () => {
		const registry = parseAgencyAgentRegistryPage(`---
type: agency-agent-registry
version: 1
agents:
  - name: lifecycle-email-copywriter
    description: Writes lifecycle email copy
    vertical: lifecycle-email
    brain:
      agencySourceId: agency
      clientSourceId: client/acme
    tools: [agency_brain_query, read]
    approvals: [publish]
    status: active
---
`);

		expect(registry).toEqual({
			type: "agency-agent-registry",
			version: 1,
			agents: [
				{
					name: "lifecycle-email-copywriter",
					description: "Writes lifecycle email copy",
					vertical: "lifecycle-email",
					brain: {
						agencySourceId: "agency",
						clientSourceId: "client/acme",
					},
					tools: ["agency_brain_query", "read"],
					approvals: ["publish"],
					status: "active",
				},
			],
			warnings: [],
		});
	});

	it("drops invalid entries and exposes warnings", () => {
		const registry = parseAgencyAgentRegistryPage(`---
type: agency-agent-registry
version: 1
agents:
  - name: missing-description
    tools: [read]
  - description: Missing name
  - not-an-object
  - name: valid-agent
    description: Valid entry
---
`);

		expect(registry.agents).toEqual([
			{
				name: "valid-agent",
				description: "Valid entry",
				vertical: undefined,
				brain: undefined,
				tools: [],
				approvals: [],
				status: "draft",
			},
		]);
		expect(registry.warnings).toEqual([
			"Dropped agent missing-description: description is required.",
			"Dropped agent at index 1: name is required.",
			"Dropped agent at index 2: entry must be an object.",
		]);
	});

	it("defaults missing status to draft", () => {
		const registry = parseAgencyAgentRegistryPage(`---
type: agency-agent-registry
version: 1
agents:
  - name: strategy-agent
    description: Drafts strategy notes
    tools: agency_brain_query, read
    approvals: publish, send-email
---
`);

		expect(registry.agents[0]?.status).toBe("draft");
		expect(registry.agents[0]?.tools).toEqual(["agency_brain_query", "read"]);
		expect(registry.agents[0]?.approvals).toEqual(["publish", "send-email"]);
	});
});

function createTestSession(settings: Settings, tool?: AgentTool): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		getToolByName: name => (tool && name === tool.name ? tool : undefined),
	};
}

function fakeMcpTool(
	name: string,
	parameters: unknown,
	execute: (params: unknown) => AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>,
): AgentTool {
	return {
		name,
		label: name,
		description: "fake MCP tool",
		parameters: parameters as AgentTool["parameters"],
		strict: true,
		execute: async (_toolCallId, params) => execute(params),
	} as AgentTool;
}

function firstText(result: AgentToolResult<unknown>): string {
	const first = result.content.find(part => part.type === "text");
	return first?.type === "text" ? first.text : "";
}

describe("agency brain tools", () => {
	it("keeps agency brain tools unavailable until explicitly enabled", async () => {
		const disabled = await createTools(createTestSession(Settings.isolated({ "agencyBrain.enabled": false })), [
			"agency_brain_query",
			"agency_brain_registry",
		]);
		expect(disabled.map(tool => tool.name)).not.toContain("agency_brain_query");
		expect(disabled.map(tool => tool.name)).not.toContain("agency_brain_registry");

		const enabled = await createTools(createTestSession(Settings.isolated({ "agencyBrain.enabled": true })), [
			"agency_brain_query",
			"agency_brain_registry",
		]);
		expect(enabled.map(tool => tool.name)).toEqual(
			expect.arrayContaining(["agency_brain_query", "agency_brain_registry"]),
		);
	});

	it("reads the configured registry slug through the configured GBrain MCP get_page tool", async () => {
		const expectedToolName = createMCPToolName("company-brain", "get_page");
		let capturedParams: unknown;
		const mcpTool = fakeMcpTool(expectedToolName, z.object({}), params => {
			capturedParams = params;
			return { content: [{ type: "text", text: "registry-page" }] };
		});
		const session = createTestSession(
			Settings.isolated({
				"agencyBrain.enabled": true,
				"agencyBrain.mcpServer": "company-brain",
				"agencyBrain.registrySlug": "org/custom-registry",
			}),
			mcpTool,
		);

		const result = await new AgencyBrainRegistryTool(session).execute("call-1", { fuzzy: false });

		expect(firstText(result)).toBe("registry-page");
		expect(capturedParams).toEqual({ slug: "org/custom-registry", fuzzy: false });
	});

	it("queries through the configured client source scope instead of raw broad GBrain access", async () => {
		const expectedToolName = createMCPToolName("gbrain", "query");
		let capturedParams: unknown;
		const mcpTool = fakeMcpTool(
			expectedToolName,
			{
				type: "object",
				required: ["query", "source_id", "limit", "image", "image_mime", "mode", "cross_modal"],
				properties: {
					query: { type: "string" },
					source_id: { type: "string" },
					limit: { type: "integer" },
					image: { type: "string" },
					image_mime: { type: "string" },
					mode: { type: "string", enum: ["conservative", "balanced", "tokenmax"] },
					cross_modal: { type: "string", enum: ["text", "image", "both", "auto"] },
				},
			},
			params => {
				capturedParams = params;
				return { content: [{ type: "text", text: "query-result" }] };
			},
		);
		const session = createTestSession(
			Settings.isolated({
				"agencyBrain.enabled": true,
				"agencyBrain.agencySourceId": "agency",
				"agencyBrain.defaultClientSourceId": "client/default",
			}),
			mcpTool,
		);

		const result = await new AgencyBrainQueryTool(session).execute("call-2", {
			query: "lifecycle email examples",
			limit: 3,
		});

		expect(firstText(result)).toBe("query-result");
		expect(capturedParams).toEqual({
			query: "lifecycle email examples",
			source_id: "client/default",
			limit: 3,
			image: "",
			image_mime: "",
			mode: "balanced",
			cross_modal: "text",
		});
	});
});
