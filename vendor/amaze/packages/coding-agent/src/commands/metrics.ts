/**
 * Inspect self-improvement metrics.
 */
import { Args, Command, Flags } from "@amaze/utils/cli";

const ACTIONS = ["show", "watch"] as const;
type MetricsAction = (typeof ACTIONS)[number];

export default class Metrics extends Command {
	static description = "Inspect self-improvement metrics";

	static args = {
		action: Args.string({ description: "Metrics action", required: false, options: [...ACTIONS] }),
	};

	static flags = {
		window: Flags.string({ description: "Metric window, for example 7d" }),
		json: Flags.boolean({ description: "Output JSON" }),
		sink: Flags.string({ description: "JSONL sink file or directory" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Metrics);
		const action = (args.action ?? "show") as MetricsAction;
		if (action === "watch") {
			const { runMetricsWatchCommand } = await import("../cli/metrics");
			await runMetricsWatchCommand({ window: flags.window, json: flags.json, sink: flags.sink });
			return;
		}
		const { runMetricsShowCommand } = await import("../cli/metrics");
		await runMetricsShowCommand({ window: flags.window, json: flags.json, sink: flags.sink });
	}
}
