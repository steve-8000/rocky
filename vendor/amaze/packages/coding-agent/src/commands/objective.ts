/**
 * Manage long-horizon objectives.
 */
import { Args, Command, Flags } from "@amaze/utils/cli";
import { isObjectiveDirection } from "../cli/objective";

const ACTIONS = ["create", "list", "show", "preview", "pause", "cancel", "enable", "disable"] as const;
type ObjectiveAction = (typeof ACTIONS)[number];

export default class Objective extends Command {
	static description =
		"Manage long-horizon objectives. Preview works regardless of autonomy.enabled; never mutates state.";

	static args = {
		action: Args.string({ description: "Objective action", required: false, options: [...ACTIONS] }),
		id: Args.string({ description: "Objective id", required: false }),
	};

	static flags = {
		db: Flags.string({ description: "Path to objectives SQLite database" }),
		id: Flags.string({ description: "Objective id for preview" }),
		title: Flags.string({ description: "Objective title" }),
		metric: Flags.string({ description: "Metric name" }),
		metrics: Flags.string({ description: "JSON metrics file for objective preview" }),
		json: Flags.boolean({ description: "Output JSON" }),
		window: Flags.string({ description: "Metric window for preview, for example 7d" }),
		proposalsDb: Flags.string({ description: "Path to proposals SQLite database" }),
		target: Flags.string({ description: "Metric target value" }),
		direction: Flags.string({ description: "Target direction: up or down" }),
		deadline: Flags.string({ description: "Target deadline in epoch milliseconds" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Objective);
		const action = (args.action ?? "list") as ObjectiveAction;

		if (action === "create") {
			if (!flags.title) throw new Error("objective create requires --title <title>");
			if (!flags.metric) throw new Error("objective create requires --metric <name>");
			if (!flags.target) throw new Error("objective create requires --target <num>");
			if (!isObjectiveDirection(flags.direction)) throw new Error("objective create requires --direction <up|down>");
			const target = Number(flags.target);
			if (!Number.isFinite(target)) throw new Error(`Invalid --target: ${flags.target}`);
			const deadline = flags.deadline === undefined ? undefined : Number(flags.deadline);
			if (deadline !== undefined && !Number.isFinite(deadline))
				throw new Error(`Invalid --deadline: ${flags.deadline}`);
			const { runObjectiveCreateCommand } = await import("../cli/objective");
			await runObjectiveCreateCommand({
				db: flags.db,
				title: flags.title,
				metric: flags.metric,
				target,
				direction: flags.direction,
				deadline,
			});
			return;
		}

		if (action === "list") {
			const { runObjectiveListCommand } = await import("../cli/objective");
			await runObjectiveListCommand({ db: flags.db });
			return;
		}

		if (action === "enable" || action === "disable") {
			const { runObjectiveSetEnabledCommand } = await import("../cli/objective");
			await runObjectiveSetEnabledCommand(action === "enable");
			return;
		}

		if (action === "preview") {
			const id = flags.id ?? args.id;
			if (!id) throw new Error("objective preview requires --id <id>");
			const { runObjectivePreviewCommand } = await import("../cli/objective");
			await runObjectivePreviewCommand({
				db: flags.db,
				id,
				metrics: flags.metrics,
				json: flags.json,
				window: flags.window,
				proposalsDb: flags.proposalsDb,
			});
			return;
		}

		if (!args.id) throw new Error(`objective ${action} requires <id>`);

		if (action === "show") {
			const { runObjectiveShowCommand } = await import("../cli/objective");
			await runObjectiveShowCommand({ db: flags.db, id: args.id });
			return;
		}

		if (action === "pause") {
			const { runObjectivePauseCommand } = await import("../cli/objective");
			await runObjectivePauseCommand({ db: flags.db, id: args.id });
			return;
		}

		const { runObjectiveCancelCommand } = await import("../cli/objective");
		await runObjectiveCancelCommand({ db: flags.db, id: args.id });
	}
}
