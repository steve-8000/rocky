import { APP_NAME } from "@amaze/utils";
import { Args, Command, Flags, renderCommandHelp } from "@amaze/utils/cli";
import { runSkillsCommand, type SkillsCliAction } from "../cli/skills-cli";

const ACTIONS: SkillsCliAction[] = ["list", "inspect", "create", "patch", "delete", "curate"];

export default class Skills extends Command {
	static description = "Manage local Amaze skills";

	static args = {
		action: Args.string({ description: "Skills action", required: false, options: ACTIONS }),
		name: Args.string({ description: "Skill name", required: false }),
	};

	static flags = {
		description: Flags.string({ description: "Skill description for create" }),
		body: Flags.string({ description: "Skill body for create" }),
		file: Flags.string({ description: "Relative skill file for patch" }),
		old: Flags.string({ description: "Exact text to replace for patch" }),
		new: Flags.string({ description: "Replacement text for patch" }),
		overwrite: Flags.boolean({ description: "Overwrite existing skill on create" }),
		"absorbed-into": Flags.string({ description: "Skill that absorbed this deleted skill" }),
		"stale-days": Flags.integer({ description: "Days before curator marks a skill stale" }),
		"archive-days": Flags.integer({ description: "Days before curator marks a skill as an archive candidate" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Skills);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "skills", Skills);
			return;
		}
		await runSkillsCommand({
			action: args.action as SkillsCliAction,
			name: args.name,
			description: flags.description,
			body: flags.body,
			file: flags.file,
			old: flags.old,
			newText: flags.new,
			overwrite: flags.overwrite,
			absorbedInto: flags["absorbed-into"],
			staleDays: flags["stale-days"],
			archiveDays: flags["archive-days"],
			json: flags.json,
		});
	}
}
