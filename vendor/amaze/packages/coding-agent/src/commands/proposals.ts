/**
 * Manage learning proposals.
 */
import { Args, Command, Flags } from "@amaze/utils/cli";
import { isProposalStatus, isProposalType } from "../cli/proposals";

const ACTIONS = ["list", "show", "approve", "reject", "apply", "rollback", "diff"] as const;
type ProposalsAction = (typeof ACTIONS)[number];

export default class Proposals extends Command {
	static description = "Manage learning proposals";

	static args = {
		action: Args.string({ description: "Proposal action", required: false, options: [...ACTIONS] }),
		id: Args.string({ description: "Proposal id", required: false }),
	};

	static flags = {
		db: Flags.string({ description: "Path to proposals SQLite database" }),
		status: Flags.string({ description: "Filter by proposal status" }),
		type: Flags.string({ description: "Filter by proposal type" }),
		reason: Flags.string({ description: "Approval or rejection reason" }),
		settingsPath: Flags.string({ description: "Path to settings JSON for applying settings proposals" }),
		skillsDir: Flags.string({ description: "Path to skills directory for applying skill proposals" }),
		rulesDir: Flags.string({ description: "Path to rules directory for applying rule proposals" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Proposals);
		const action = (args.action ?? "list") as ProposalsAction;

		if (flags.status !== undefined && !isProposalStatus(flags.status)) {
			throw new Error(`Invalid proposal status: ${flags.status}`);
		}
		if (flags.type !== undefined && !isProposalType(flags.type)) {
			throw new Error(`Invalid proposal type: ${flags.type}`);
		}

		if (action === "list") {
			const { runProposalsListCommand } = await import("../cli/proposals");
			await runProposalsListCommand({ db: flags.db, status: flags.status, type: flags.type });
			return;
		}

		if (!args.id) throw new Error(`proposals ${action} requires <id>`);

		if (action === "show") {
			const { runProposalsShowCommand } = await import("../cli/proposals");
			await runProposalsShowCommand({ db: flags.db, id: args.id });
			return;
		}

		if (action === "approve") {
			const { runProposalsApproveCommand } = await import("../cli/proposals");
			await runProposalsApproveCommand({ db: flags.db, id: args.id, reason: flags.reason });
			return;
		}

		if (action === "reject") {
			if (!flags.reason) throw new Error("proposals reject requires --reason <reason>");
			const { runProposalsRejectCommand } = await import("../cli/proposals");
			await runProposalsRejectCommand({ db: flags.db, id: args.id, reason: flags.reason });
			return;
		}

		if (action === "apply") {
			const { runProposalsApplyCommand } = await import("../cli/proposals");
			await runProposalsApplyCommand({
				db: flags.db,
				id: args.id,
				settingsPath: flags.settingsPath,
				skillsDir: flags.skillsDir,
				rulesDir: flags.rulesDir,
			});
			return;
		}

		if (action === "rollback") {
			const { runProposalsRollbackCommand } = await import("../cli/proposals");
			await runProposalsRollbackCommand({ db: flags.db, id: args.id });
			return;
		}

		const { runProposalsDiffCommand } = await import("../cli/proposals");
		await runProposalsDiffCommand({ db: flags.db, id: args.id });
	}
}
