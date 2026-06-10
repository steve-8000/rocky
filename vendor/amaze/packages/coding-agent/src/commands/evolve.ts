/**
 * Operator control plane for the autonomy + learning loop.
 */
import { Args, Command, Flags } from "@amaze/utils/cli";
import { isProposalStatus, isProposalType } from "../cli/proposals";

const ACTIONS = [
	"status",
	"objectives",
	"preview",
	"proposals",
	"inspect",
	"approve",
	"apply",
	"rollback",
	"simulate",
	"doctor",
] as const;
type EvolveAction = (typeof ACTIONS)[number];

export default class Evolve extends Command {
	static description = "Operator control plane for the autonomy + learning loop";

	static args = {
		action: Args.string({ description: "Evolution action", required: false, options: [...ACTIONS] }),
		id: Args.string({ description: "Objective or proposal id", required: false }),
	};

	static flags = {
		db: Flags.string({ description: "Path to objectives SQLite database" }),
		proposalsDb: Flags.string({ description: "Path to proposals SQLite database" }),
		objective: Flags.string({ description: "Objective id for preview" }),
		id: Flags.string({ description: "Proposal id" }),
		reason: Flags.string({ description: "Approval reason" }),
		metrics: Flags.string({ description: "JSON metrics file for objective preview" }),
		window: Flags.string({ description: "Metric window for preview, for example 7d" }),
		json: Flags.boolean({ description: "Output JSON" }),
		settingsPath: Flags.string({ description: "Path to settings JSON for applying settings proposals" }),
		skillsDir: Flags.string({ description: "Path to skills directory for applying skill proposals" }),
		rulesDir: Flags.string({ description: "Path to rules directory for applying rule proposals" }),
		status: Flags.string({ description: "Filter by proposal status" }),
		type: Flags.string({ description: "Filter by proposal type" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Evolve);
		const action = (args.action ?? "status") as EvolveAction;

		if (action === "status") {
			const { runEvolveStatusCommand } = await import("../cli/evolve");
			await runEvolveStatusCommand({ db: flags.db, proposalsDb: flags.proposalsDb });
			return;
		}

		if (action === "objectives") {
			const { runObjectiveListCommand } = await import("../cli/objective");
			await runObjectiveListCommand({ db: flags.db });
			return;
		}

		if (action === "preview") {
			const id = flags.objective ?? args.id;
			if (!id) throw new Error("evolve preview requires --objective <id> or <id>");
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

		if (action === "proposals") {
			if (flags.status !== undefined && !isProposalStatus(flags.status)) {
				throw new Error(`Invalid proposal status: ${flags.status}`);
			}
			if (flags.type !== undefined && !isProposalType(flags.type)) {
				throw new Error(`Invalid proposal type: ${flags.type}`);
			}
			const { runProposalsListCommand } = await import("../cli/proposals");
			await runProposalsListCommand({ db: flags.proposalsDb, status: flags.status, type: flags.type });
			return;
		}

		if (action === "doctor") {
			const { runEvolveDoctorCommand } = await import("../cli/evolve");
			await runEvolveDoctorCommand({ db: flags.db });
			return;
		}

		const id = flags.id ?? args.id;
		if (!id) throw new Error(`evolve ${action} requires --id <id> or <id>`);

		if (action === "inspect") {
			const { runProposalsShowCommand } = await import("../cli/proposals");
			await runProposalsShowCommand({ db: flags.proposalsDb, id });
			return;
		}

		if (action === "approve") {
			const { runProposalsApproveCommand } = await import("../cli/proposals");
			await runProposalsApproveCommand({ db: flags.proposalsDb, id, reason: flags.reason });
			return;
		}

		if (action === "apply") {
			const { runProposalsApplyCommand } = await import("../cli/proposals");
			await runProposalsApplyCommand({
				db: flags.proposalsDb,
				id,
				settingsPath: flags.settingsPath,
				skillsDir: flags.skillsDir,
				rulesDir: flags.rulesDir,
			});
			return;
		}

		if (action === "rollback") {
			const { runProposalsRollbackCommand } = await import("../cli/proposals");
			await runProposalsRollbackCommand({ db: flags.proposalsDb, id });
			return;
		}

		const { runEvolveSimulateCommand } = await import("../cli/evolve");
		await runEvolveSimulateCommand({ db: flags.proposalsDb, id });
	}
}
