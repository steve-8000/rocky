/**
 * Manage and run observability rules.
 */
import { Args, Command, Flags } from "@amaze/utils/cli";

const ACTIONS = ["list", "show", "run", "lint", "approve"] as const;
type RulesAction = (typeof ACTIONS)[number];

export default class Rules extends Command {
	static description = "Manage observability rules";

	static args = {
		action: Args.string({ description: "Rules action", required: false, options: [...ACTIONS] }),
		value: Args.string({ description: "Rule id or path", required: false }),
	};

	static flags = {
		since: Flags.string({ description: "Only include events at or after this timestamp" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Rules);
		const action = (args.action ?? "list") as RulesAction;

		if (action === "list") {
			const { runRulesListCommand } = await import("../cli/rules");
			await runRulesListCommand();
			return;
		}

		if (action === "show") {
			if (!args.value) throw new Error("rules show requires <id>");
			const { runRulesShowCommand } = await import("../cli/rules");
			await runRulesShowCommand({ id: args.value });
			return;
		}

		if (action === "run") {
			const { runRulesRunCommand } = await import("../cli/rules");
			await runRulesRunCommand({ since: parseOptionalNumber(flags.since, "--since") });
			return;
		}

		if (!args.value) throw new Error(`rules ${action} requires <path>`);
		if (action === "lint") {
			const { runRulesLintCommand } = await import("../cli/rules");
			await runRulesLintCommand(args.value);
			return;
		}

		const { runRulesApproveCommand } = await import("../cli/rules");
		await runRulesApproveCommand(args.value);
	}
}

function parseOptionalNumber(value: string | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
	return parsed;
}
