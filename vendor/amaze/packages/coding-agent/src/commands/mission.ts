import { Args, Command, Flags } from "@amaze/utils/cli";

const ACTIONS = ["list", "show", "stream", "lanes", "evidence", "decision", "verify", "rollback"] as const;
type MissionAction = (typeof ACTIONS)[number];

export default class Mission extends Command {
	static description = "Mission Control read-only operator views.";

	static args = {
		action: Args.string({ description: "Mission action", required: false, options: [...ACTIONS] }),
		id: Args.string({ description: "Mission id", required: false }),
	};

	static flags = {
		db: Flags.string({ description: "Path to autonomy SQLite database (default ~/.amaze/autonomy/autonomy.db)" }),
		json: Flags.boolean({ description: "Output JSON" }),
		objective: Flags.string({ description: "Objective id filter" }),
		brief: Flags.string({ description: "Research brief id filter" }),
		state: Flags.string({ description: "Mission state filter" }),
		follow: Flags.boolean({ description: "Follow stream by polling mission event JSONL" }),
		events: Flags.string({
			description: "Mission event JSONL directory for replay verification (mission verify only)",
		}),
		lane: Flags.string({ description: "Evidence lane filter (mission evidence only)" }),
		grade: Flags.string({ description: "Evidence grade filter (mission evidence only)" }),
		status: Flags.string({ description: "Evidence classification filter: accepted, speculative, or conflicting" }),
		query: Flags.string({
			description: "Case-insensitive evidence source/excerpt/claim search (mission evidence only)",
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Mission);
		if (!args.action) {
			process.stdout.write(
				"usage: amaze mission <list|show|stream|lanes|evidence|decision|verify|rollback> [...]\n",
			);
			return;
		}
		const action = args.action as MissionAction;

		if (action === "list") {
			const { runMissionListCommand } = await import("../cli/mission");
			await runMissionListCommand({
				db: flags.db,
				objectiveId: flags.objective,
				briefId: flags.brief,
				state: flags.state,
				json: flags.json,
			});
			return;
		}

		const id = args.id;
		if (!id) throw new Error(`mission ${action} requires <mission-id>`);

		if (action === "show") {
			const { runMissionShowCommand } = await import("../cli/mission");
			await runMissionShowCommand({ db: flags.db, id, json: flags.json });
			return;
		}
		if (action === "stream") {
			const { runMissionStreamCommand } = await import("../cli/mission");
			await runMissionStreamCommand({ db: flags.db, id, json: flags.json, follow: flags.follow });
			return;
		}
		if (action === "lanes") {
			const { runMissionLanesCommand } = await import("../cli/mission");
			await runMissionLanesCommand({ db: flags.db, id, json: flags.json });
			return;
		}
		if (action === "evidence") {
			const { runMissionEvidenceCommand } = await import("../cli/mission");
			await runMissionEvidenceCommand({
				db: flags.db,
				id,
				json: flags.json,
				lane: flags.lane,
				grade: flags.grade,
				status: parseEvidenceStatus(flags.status),
				query: flags.query,
			});
			return;
		}
		if (action === "decision") {
			const { runMissionDecisionCommand } = await import("../cli/mission");
			await runMissionDecisionCommand({ db: flags.db, id, json: flags.json });
			return;
		}
		if (action === "verify") {
			const { runMissionVerifyCommand } = await import("../cli/mission");
			await runMissionVerifyCommand({ db: flags.db, id, json: flags.json, events: flags.events });
			return;
		}
		const { runMissionRollbackCommand } = await import("../cli/mission");
		await runMissionRollbackCommand({ db: flags.db, id, json: flags.json });
	}
}

function parseEvidenceStatus(value: string | undefined): "accepted" | "speculative" | "conflicting" | undefined {
	if (value === undefined) return undefined;
	if (value === "accepted" || value === "speculative" || value === "conflicting") return value;
	throw new Error(`Invalid evidence status: ${value}`);
}
