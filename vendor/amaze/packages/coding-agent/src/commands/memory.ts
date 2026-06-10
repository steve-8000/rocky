/**
 * Show memory diagnostics.
 */
import { Args, Command } from "@amaze/utils/cli";

const ACTIONS = ["doctor"] as const;

type MemoryAction = (typeof ACTIONS)[number];

export default class Memory extends Command {
	static description = "Show memory diagnostics";

	static args = {
		action: Args.string({
			description: "Memory action",
			required: false,
			options: [...ACTIONS],
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Memory);
		const action = (args.action ?? "doctor") as MemoryAction;

		const { runMemoryCommand } = await import("../cli/memory");
		await runMemoryCommand({ action });
	}
}
