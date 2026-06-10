import { getAgentDir } from "@amaze/utils";
import { runSkillCurator } from "../extensibility/skill-curator";
import { SkillManager } from "../extensibility/skill-manager";

export type SkillsCliAction = "list" | "inspect" | "create" | "patch" | "delete" | "curate";

export interface SkillsCommandArgs {
	action: SkillsCliAction;
	name?: string;
	description?: string;
	body?: string;
	file?: string;
	old?: string;
	newText?: string;
	overwrite?: boolean;
	absorbedInto?: string;
	staleDays?: number;
	archiveDays?: number;
	json?: boolean;
}

export async function runSkillsCommand(args: SkillsCommandArgs): Promise<void> {
	const agentDir = getAgentDir();
	if (args.action === "curate") {
		const report = await runSkillCurator({
			agentDir,
			staleAfterDays: args.staleDays,
			archiveAfterDays: args.archiveDays,
		});
		process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatCuratorReport(report));
		return;
	}
	const manager = new SkillManager({ agentDir });
	const result = await dispatchSkillAction(manager, args);
	process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSkillResult(result)}\n`);
}

async function dispatchSkillAction(manager: SkillManager, args: SkillsCommandArgs) {
	switch (args.action) {
		case "list":
			return manager.list();
		case "inspect":
			return manager.inspect(required(args.name, "name"));
		case "create":
			return manager.create({
				name: required(args.name, "name"),
				description: required(args.description, "--description"),
				body: required(args.body, "--body"),
				overwrite: args.overwrite,
			});
		case "patch":
			return manager.patch({
				name: required(args.name, "name"),
				relativePath: args.file,
				oldText: required(args.old, "--old"),
				newText: required(args.newText, "--new"),
			});
		case "delete":
			return manager.delete({ name: required(args.name, "name"), absorbedInto: args.absorbedInto });
		case "curate":
			throw new Error("curate is handled before skill mutation dispatch");
	}
}

function required(value: string | undefined, label: string): string {
	if (!value) throw new Error(`${label} is required`);
	return value;
}

function formatSkillResult(result: Awaited<ReturnType<SkillManager["list"]>>): string {
	if (result.entries) {
		if (result.entries.length === 0) return "No local skills found.";
		return result.entries.map(entry => `${entry.name}\t${entry.description ?? ""}\t${entry.path}`).join("\n");
	}
	if (result.content !== undefined) return result.content;
	return result.message;
}

function formatCuratorReport(report: Awaited<ReturnType<typeof runSkillCurator>>): string {
	if (report.candidates.length === 0) return "No local skills found.\n";
	const rows = report.candidates.map(candidate =>
		[
			candidate.name,
			candidate.status,
			String(candidate.useCount),
			candidate.lastUsedAt ?? "never",
			candidate.reason,
		].join("\t"),
	);
	return `${rows.join("\n")}\n`;
}
