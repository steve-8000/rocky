import type { RuleFinding } from "../rules";
import type { LearningProposal } from "./types";

interface RuleFindingToProposalOptions {
	sessionId?: string;
}

type ProposalWithoutRuntimeFields = Omit<LearningProposal, "id" | "createdAt" | "status"> & Record<string, unknown>;

export function ruleFindingToProposal(
	finding: RuleFinding,
	opts: RuleFindingToProposalOptions = {},
): ProposalWithoutRuntimeFields | null {
	const sessionIds = opts.sessionId ? [opts.sessionId] : [];
	const base = {
		evidence: {
			sessionIds,
			eventRefs: [],
			ruleFindings: [finding.ruleId],
			sampleN: finding.count,
		},
		provenance: { source: "rule" as const, ruleId: finding.ruleId },
	};

	if (finding.ruleId === "force-complete-rate") {
		return {
			...base,
			type: "settings",
			gate: "human-required",
			patch: { "goal.uncertainPolicy": "block-manual" },
			reason: finding.message,
			rollback: { "goal.uncertainPolicy": "allow" },
		};
	}

	if (finding.ruleId === "memory-low-precision") {
		return {
			...base,
			type: "memory",
			gate: "review",
			content: "Memory hit precision low; consider tightening recall scope.",
			memoryType: "note",
			confidence: "inferred",
		};
	}

	return {
		...base,
		type: "rule",
		gate: "review",
		ruleMarkdown: "",
		replaySessions: sessionIds,
		expectedImpact: finding.message,
	};
}
