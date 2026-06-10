import { ObjectiveStore } from "../autonomy";
import type { EvoStage } from "../autonomy/evo-trace";
import { DEFAULT_AUTONOMY_FORBIDDEN_SCOPES, normalizeObjectiveGuardrails } from "../autonomy/guardrails";
import { ProposalStore } from "../learning";
import { evaluateProposal } from "../learning/eval/pipeline";

export interface EvolveStatusArgs {
	db?: string;
	proposalsDb?: string;
}

export interface EvolveDoctorArgs {
	db?: string;
}

export interface EvolveSimulateArgs {
	db?: string;
	id: string;
}

const EVO_EVENT_KINDS = new Set<EvoStage>([
	"objective",
	"signal",
	"proposal",
	"eval",
	"human-gate",
	"applied",
	"rolled-back",
	"blocked",
]);

export async function runEvolveStatusCommand(args: EvolveStatusArgs): Promise<void> {
	const objectives = new ObjectiveStore(args.db);
	const proposals = new ProposalStore(args.proposalsDb);
	try {
		const activeObjectives = objectives.list().filter(objective => objective.status === "active");
		const pendingProposals = proposals.listByStatus("pending");
		const lines = [
			"EVOLUTION STATE",
			`Active objectives: ${activeObjectives.length}`,
			`Pending proposals: ${pendingProposals.length}`,
			`Guardrail defaults: ${DEFAULT_AUTONOMY_FORBIDDEN_SCOPES.join(", ")}`,
		];
		if (activeObjectives.length === 0 && pendingProposals.length === 0) {
			lines.push("No active evolution flow.");
		}
		for (const objective of activeObjectives) {
			const events = objectives
				.listEvents(objective.id)
				.filter(event => EVO_EVENT_KINDS.has(event.kind as EvoStage))
				.slice(-3);
			if (events.length === 0) continue;
			lines.push(`Recent evolution events for ${objective.id}:`);
			for (const event of events) {
				lines.push(`  ${new Date(event.ts).toISOString()}  ${event.kind}  ${summarizeEventPayload(event.payload)}`);
			}
		}
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		proposals.close();
		objectives.close();
	}
}

function summarizeEventPayload(payload: Record<string, unknown>): string {
	const summary = JSON.stringify(payload);
	return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

export async function runEvolveDoctorCommand(args: EvolveDoctorArgs): Promise<void> {
	const objectives = new ObjectiveStore(args.db);
	try {
		const activeObjectives = objectives.list().filter(objective => objective.status === "active");
		const lines = ["EVOLVE DOCTOR", "Default guardrail forbidden scopes:"];
		for (const scope of DEFAULT_AUTONOMY_FORBIDDEN_SCOPES) {
			lines.push(`  - ${scope}`);
		}
		lines.push(`Active objectives: ${activeObjectives.length}`);
		for (const objective of activeObjectives) {
			const guardrails = normalizeObjectiveGuardrails(objective.guardrails);
			lines.push(`${objective.id}: ${guardrails.forbiddenScopes.join(", ")}`);
		}
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		objectives.close();
	}
}

export async function runEvolveSimulateCommand(args: EvolveSimulateArgs): Promise<void> {
	const store = new ProposalStore(args.db);
	try {
		const proposal = store.get(args.id);
		if (!proposal) {
			process.stderr.write(`proposal not found: ${args.id}\n`);
			process.exitCode = 1;
			return;
		}
		const report = await evaluateProposal(proposal, {});
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} finally {
		store.close();
	}
}
