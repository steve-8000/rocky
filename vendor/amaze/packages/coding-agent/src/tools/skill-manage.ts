import type { AgentTool, AgentToolResult } from "@amaze/agent-core";
import * as z from "zod/v4";
import { SkillManager } from "../extensibility/skill-manager";
import type { ToolSession } from ".";

const skillManageSchema = z.object({
	action: z.enum(["create", "inspect", "list", "write_file", "remove_file", "patch", "delete"]),
	name: z.string().optional().describe("skill name"),
	description: z.string().optional().describe("skill description for create"),
	body: z.string().optional().describe("full SKILL.md body after frontmatter for create"),
	relativePath: z.string().optional().describe("path inside the skill directory"),
	content: z.string().optional().describe("file content for write_file"),
	oldText: z.string().optional().describe("exact text to replace for patch"),
	newText: z.string().optional().describe("replacement text for patch"),
	overwrite: z.boolean().optional().describe("allow replacing an existing skill or file"),
	absorbedInto: z.string().optional().describe("skill that absorbed this deleted skill"),
});

type SkillManageParams = z.infer<typeof skillManageSchema>;

export class SkillManageTool implements AgentTool<typeof skillManageSchema> {
	readonly name = "skill_manage";
	readonly label = "Skill Manage";
	readonly summary = "Create, inspect, patch, and delete local Amaze skills";
	readonly loadMode = "discoverable";
	readonly parameters = skillManageSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly description = [
		"Manage local Amaze skills under the configured agent skills directory.",
		"Mutations are path-contained, validate SKILL.md frontmatter, and write atomically.",
		"Use create for new skills, patch for exact single-match edits, write_file for support files, and delete for removing a managed skill.",
	].join("\n");

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: SkillManageParams, signal?: AbortSignal): Promise<AgentToolResult> {
		signal?.throwIfAborted();
		const manager = new SkillManager({ agentDir: this.session.settings.getAgentDir() });
		const result = await this.#dispatch(manager, params);
		signal?.throwIfAborted();
		return {
			content: [{ type: "text", text: formatSkillManageResult(result) }],
			details: result,
		};
	}

	async #dispatch(manager: SkillManager, params: SkillManageParams) {
		switch (params.action) {
			case "list":
				return manager.list();
			case "inspect":
				return manager.inspect(requireName(params));
			case "create":
				return manager.create({
					name: requireName(params),
					description: requireField(params.description, "description"),
					body: requireField(params.body, "body"),
					overwrite: params.overwrite,
				});
			case "write_file":
				return manager.writeFile({
					name: requireName(params),
					relativePath: requireField(params.relativePath, "relativePath"),
					content: requireField(params.content, "content"),
					overwrite: params.overwrite,
				});
			case "remove_file":
				return manager.removeFile({
					name: requireName(params),
					relativePath: requireField(params.relativePath, "relativePath"),
				});
			case "patch":
				return manager.patch({
					name: requireName(params),
					relativePath: params.relativePath,
					oldText: requireField(params.oldText, "oldText"),
					newText: requireField(params.newText, "newText"),
				});
			case "delete":
				return manager.delete({ name: requireName(params), absorbedInto: params.absorbedInto });
		}
	}
}

function requireName(params: SkillManageParams): string {
	return requireField(params.name, "name");
}

function requireField(value: string | undefined, name: string): string {
	if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
	return value;
}

function formatSkillManageResult(result: Awaited<ReturnType<SkillManager["list"]>>): string {
	if (result.entries) {
		if (result.entries.length === 0) return "No local skills found.";
		return result.entries.map(entry => `${entry.name}\t${entry.description ?? ""}\t${entry.path}`).join("\n");
	}
	if (result.content !== undefined) return result.content;
	return result.message;
}
