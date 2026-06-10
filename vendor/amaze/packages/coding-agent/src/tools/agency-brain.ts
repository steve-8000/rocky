import type { AgentTool, AgentToolResult } from "@amaze/agent-core";
import { untilAborted } from "@amaze/utils";
import * as z from "zod/v4";
import { createMCPToolName } from "../mcp/tool-bridge";
import type { ToolSession } from "./index";

const registrySchema = z.object({
	slug: z.string().optional().describe("Optional GBrain page slug. Defaults to agencyBrain.registrySlug."),
	fuzzy: z.boolean().optional().default(false).describe("Whether to allow fuzzy page lookup. Default false."),
});

const querySchema = z.object({
	query: z.string().describe("Scoped agency/client brain query."),
	client_source_id: z.string().optional().describe("Optional client pod source id overriding configured defaults."),
	limit: z.number().int().min(1).max(20).optional().describe("Maximum results to return, 1..20."),
});

type RegistryParams = z.infer<typeof registrySchema>;
type QueryParams = z.infer<typeof querySchema>;

export interface AgencyBrainDetails {
	mcpToolName?: string;
	sourceId?: string;
	error?: string;
}

type JsonSchemaObject = {
	type?: string | string[];
	enum?: unknown[];
	default?: unknown;
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
};
type QueryArgs = Record<string, string | number | boolean>;

type ExecutableTool = AgentTool & {
	execute: (...args: unknown[]) => Promise<AgentToolResult<unknown>>;
};

function textResult(
	text: string,
	details: AgencyBrainDetails = {},
	isError = false,
): AgentToolResult<AgencyBrainDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function getConfiguredServerName(session: ToolSession): string {
	const configured = session.settings.get("agencyBrain.mcpServer")?.trim();
	return configured || "gbrain";
}

function getMcpTool(session: ToolSession, mcpToolName: "get_page" | "query"): { name: string; tool?: ExecutableTool } {
	const name = createMCPToolName(getConfiguredServerName(session), mcpToolName);
	const tool = session.getToolByName?.(name) as ExecutableTool | undefined;
	return { name, tool };
}

function getTextContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

function withMcpError(
	result: AgentToolResult<unknown>,
	details: AgencyBrainDetails,
): AgentToolResult<AgencyBrainDetails> {
	return {
		content: [{ type: "text", text: getTextContent(result) }],
		details,
		...(result.isError ? { isError: true } : {}),
	};
}

async function executeMcpTool(
	tool: ExecutableTool,
	toolCallId: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	return await tool.execute(toolCallId, params, signal);
}

function isEnabled(session: ToolSession): boolean {
	return session.settings.get("agencyBrain.enabled") === true;
}

export class AgencyBrainRegistryTool implements AgentTool<typeof registrySchema, AgencyBrainDetails> {
	readonly name = "agency_brain_registry";
	readonly label = "AgencyBrainRegistry";
	readonly summary = "Read the configured GBrain agency registry page";
	readonly loadMode = "discoverable";
	readonly parameters = registrySchema;
	readonly strict = true;
	readonly description =
		"Read the configured GBrain registry page for agency org chart, client pods, and agent registry. Uses the active gBrain MCP get_page tool; unavailable unless agencyBrain.enabled is true.";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): AgencyBrainRegistryTool | null {
		return isEnabled(session) ? new AgencyBrainRegistryTool(session) : null;
	}

	async execute(
		toolCallId: string,
		params: RegistryParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AgencyBrainDetails>> {
		return untilAborted(signal, async () => {
			const { name, tool } = getMcpTool(this.session, "get_page");
			if (!tool) {
				return textResult(
					`GBrain get_page MCP tool is not active or available. Expected active tool: ${name}. Activate/configure the ${getConfiguredServerName(this.session)} MCP server get_page tool first.`,
					{ mcpToolName: name, error: "missing_mcp_tool" },
					true,
				);
			}

			const slug =
				params.slug?.trim() || this.session.settings.get("agencyBrain.registrySlug") || "org/agent-registry";
			const result = await executeMcpTool(tool, toolCallId, { slug, fuzzy: params.fuzzy ?? false }, signal);
			return withMcpError(result, { mcpToolName: name });
		});
	}
}

function resolveSourceId(session: ToolSession, clientSourceId?: string): string {
	const explicit = clientSourceId?.trim();
	if (explicit) return explicit;
	const configuredClient = session.settings.get("agencyBrain.defaultClientSourceId")?.trim();
	if (configuredClient) return configuredClient;
	return session.settings.get("agencyBrain.agencySourceId") || "__all__";
}

function schemaObject(value: unknown): JsonSchemaObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchemaObject) : {};
}

function schemaType(schema: JsonSchemaObject): string | undefined {
	return Array.isArray(schema.type) ? schema.type.find(type => type !== "null") : schema.type;
}

function enumString(schema: JsonSchemaObject, preferred: string[]): string | undefined {
	const values = schema.enum?.filter((value): value is string => typeof value === "string") ?? [];
	return preferred.find(value => values.includes(value)) ?? values[0];
}

function defaultValueForField(name: string, schema: JsonSchemaObject): string | number | boolean {
	if (
		typeof schema.default === "string" ||
		typeof schema.default === "number" ||
		typeof schema.default === "boolean"
	) {
		return schema.default;
	}

	const normalized = name.toLowerCase();
	const enumDefault =
		normalized.includes("mode") || normalized.includes("strategy")
			? enumString(schema, ["balanced", "semantic", "hybrid", "text", "off"])
			: normalized.includes("format")
				? enumString(schema, ["text", "markdown", "json"])
				: normalized.includes("rerank") || normalized.includes("expand")
					? enumString(schema, ["off", "false", "none"])
					: enumString(schema, []);
	if (enumDefault !== undefined) return enumDefault;

	const type = schemaType(schema);
	if (type === "boolean") return false;
	if (type === "number" || type === "integer") return 0;
	return "";
}

function buildGBrainQueryArgs(tool: ExecutableTool, query: string, sourceId: string, limit: number): QueryArgs {
	const args: QueryArgs = { query, source_id: sourceId, limit };
	const parameters = schemaObject(tool.parameters);
	const properties = parameters.properties ?? {};
	const required = new Set(parameters.required ?? []);

	for (const [name, propertySchema] of Object.entries(properties)) {
		if (name in args) continue;
		const normalized = name.toLowerCase();
		if (normalized === "sourceid") {
			args[name] = sourceId;
			continue;
		}
		if (normalized === "q" || normalized === "question" || normalized === "prompt") {
			args[name] = query;
			continue;
		}
		if (normalized === "max_results" || normalized === "top_k" || normalized === "k") {
			args[name] = limit;
			continue;
		}

		const type = schemaType(propertySchema);
		const shouldDefault =
			required.has(name) ||
			type === "string" ||
			normalized.includes("mode") ||
			normalized.includes("format") ||
			normalized.includes("rerank") ||
			normalized.includes("filter") ||
			normalized.includes("context");
		if (shouldDefault) {
			args[name] = defaultValueForField(name, propertySchema);
		}
	}

	return args;
}

export class AgencyBrainQueryTool implements AgentTool<typeof querySchema, AgencyBrainDetails> {
	readonly name = "agency_brain_query";
	readonly label = "AgencyBrainQuery";
	readonly summary = "Query GBrain through a configured agency/client source scope";
	readonly loadMode = "discoverable";
	readonly parameters = querySchema;
	readonly strict = true;
	readonly description =
		"Scoped wrapper for GBrain query. Uses client_source_id, agencyBrain.defaultClientSourceId, or agencyBrain.agencySourceId for source_id so specialist agents do not need raw broad gBrain access.";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): AgencyBrainQueryTool | null {
		return isEnabled(session) ? new AgencyBrainQueryTool(session) : null;
	}

	async execute(
		toolCallId: string,
		params: QueryParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AgencyBrainDetails>> {
		return untilAborted(signal, async () => {
			const query = params.query.trim();
			if (!query) {
				return textResult("Query is required and must not be empty.", { error: "empty_query" }, true);
			}

			const { name, tool } = getMcpTool(this.session, "query");
			if (!tool) {
				return textResult(
					`GBrain query MCP tool is not active or available. Expected active tool: ${name}. Activate/configure the ${getConfiguredServerName(this.session)} MCP server query tool first.`,
					{ mcpToolName: name, error: "missing_mcp_tool" },
					true,
				);
			}

			const sourceId = resolveSourceId(this.session, params.client_source_id);
			const result = await executeMcpTool(
				tool,
				toolCallId,
				buildGBrainQueryArgs(tool, query, sourceId, params.limit ?? 10),
				signal,
			);
			return withMcpError(result, { mcpToolName: name, sourceId });
		});
	}
}
