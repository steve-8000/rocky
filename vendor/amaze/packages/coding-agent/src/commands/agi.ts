import { Args, Command, Flags } from "@amaze/utils/cli";

const ACTIONS = ["tui", "status", "events", "actions", "add", "run", "pause", "resume", "unblock", "remove"] as const;
type AgiAction = (typeof ACTIONS)[number];

export default class Agi extends Command {
	static description = "Open the AGI gateway TUI and manage monitored sessions";

	static args = {
		action: Args.string({ description: "AGI action", required: false, options: [...ACTIONS] }),
	};

	static flags = {
		db: Flags.string({ description: "Path to AGI gateway SQLite database" }),
		session: Flags.string({ description: "Session id or .jsonl path to add/control/filter" }),
		cwd: Flags.string({ description: "Current project directory for local session preference" }),
		"tick-ms": Flags.integer({ description: "AGI supervisor polling interval in milliseconds" }),
		once: Flags.boolean({ description: "Run exactly one AGI supervisor tick" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agi);
		const action = (args.action ?? "tui") as AgiAction;
		const { runAgiCommand } = await import("../cli/agi");
		await runAgiCommand({
			action,
			db: flags.db,
			session: flags.session,
			cwd: flags.cwd,
			tickMs: flags["tick-ms"],
			once: flags.once,
		});
	}
}
