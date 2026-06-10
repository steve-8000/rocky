import { templateFor } from "../../mission/core/lifecycle-template";
import type { MissionControlRuntime } from "../../mission/core/mission-control-runtime";
import { computeArtifactSha256HexSync } from "../../utils/artifact-hash";
import type { ToolDescriptor, ToolExecutionContext, ToolRiskLevel } from "../registry/tool-descriptor";
import { isReadOnlyBashCommand } from "./bash-readonly-classifier";
import { GATEWAY_MUTATION_TOOLS } from "./session-gateway";
import type { PolicyDecision, PolicyGate } from "./tool-gateway";

export interface MissionPolicyGateDeps {
	missionControl: MissionControlRuntime;
	mutationToolNames?: ReadonlySet<string>;
}

export class MissionPolicyGate implements PolicyGate {
	readonly #deps: MissionPolicyGateDeps;
	readonly #mutationTools: ReadonlySet<string>;

	constructor(deps: MissionPolicyGateDeps) {
		this.#deps = deps;
		this.#mutationTools = deps.mutationToolNames ?? GATEWAY_MUTATION_TOOLS;
	}

	check(descriptor: ToolDescriptor, ctx: ToolExecutionContext, _riskLevel: ToolRiskLevel): PolicyDecision {
		if (!this.#mutationTools.has(descriptor.name)) return { allowed: true };

		// Special-case bash: the gateway lists it as mutation because a shell can do anything,
		// but read-only investigation (e.g. `kubectl get`, `git status`, `ls`) is statically
		// classifiable and should not require any policy enforcement. Anything not provably
		// read-only stays gated. See bash-readonly-classifier.ts for the allow-list.
		if (descriptor.name === "bash") {
			const command = (ctx.input as { command?: unknown } | undefined)?.command;
			if (typeof command === "string" && isReadOnlyBashCommand(command)) {
				return { allowed: true };
			}
		}

		const explicitRole = ctx.agentRole;
		const mission = this.#deps.missionControl.getActiveMission();

		if (!mission) {
			// Orchestrator explicitly identified itself and has full authority — allow even without
			// an active mission. Anything else (subagent or ambient/unidentified call) needs a
			// mission first; the session gateway will auto-promote from ambient and retry once.
			if (explicitRole === "orchestrator") return { allowed: true };
			return {
				allowed: false,
				reason:
					"mission-required: subagents cannot mutate without an active mission. Use `irc` to ask the orchestrator (id `0-Main`) to promote a mission, or hand the task back.",
				code: "PROMOTE_REQUIRED",
			};
		}

		// With a mission in scope, the absent-role fallback collapses to orchestrator: legacy
		// sessions that predate role plumbing keep their pre-P4 "allow everything" semantics.
		const role = explicitRole ?? "orchestrator";
		if (role === "orchestrator") return { allowed: true };

		// Proposal invariant: a proposal-required intent may not run a mutation tool until an
		// approved proposal is attached — independent of lifecycle. Subagents do NOT approve
		// proposals themselves; the orchestrator owns approval. Steer the subagent to IRC.
		const template = templateFor(mission.intent ?? "code_change");
		if (template.requireProposalBeforeMutation) {
			if (!mission.proposalId) {
				return {
					allowed: false,
					reason:
						"proposal-required: this mission needs an approved proposal before mutation, and subagents cannot attach one. Use `irc` to send your proposal request to `0-Main` (the orchestrator) with the change summary, scope, and risk; it will attach the proposal and re-dispatch.",
					code: "PROPOSAL_REQUIRED",
				};
			}
			// P4: when the durable store has a row for this proposal, require status === "approved".
			// Missing rows are tolerated (legacy missions only have a string pointer); rows present
			// in any other status (draft / applied / rolled_back) block until re-approved.
			const record = this.#deps.missionControl.getActiveProposal();
			if (record && record.status !== "approved") {
				return {
					allowed: false,
					reason: `proposal-not-approved: the attached proposal is in status "${record.status}". Ask the orchestrator (\`0-Main\`) via \`irc\` to re-approve it before mutating.`,
					code: "PROPOSAL_NOT_APPROVED",
				};
			}
			if (record?.artifactUri && record.contentHash) {
				// PolicyGate.check is synchronous and used by the pre-execution guard pipeline;
				// re-hash synchronously here so mutation gating remains a same-turn decision.
				const actual = computeArtifactSha256HexSync(record.artifactUri);
				if (actual !== record.contentHash) {
					return {
						allowed: false,
						reason: "proposal-artifact-drift",
						code: "PROPOSAL_ARTIFACT_DRIFT",
						details: { proposalId: record.id, expected: record.contentHash, actual },
					};
				}
			}
		}

		return { allowed: true };
	}
}
