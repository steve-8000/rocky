import type { LearningProposal } from "../types";

export interface GateResult {
	passed: boolean;
	reason?: string;
}

export function evaluateProvenanceGate(proposal: LearningProposal): GateResult {
	if (proposal.type === "memory") {
		if (proposal.confidence === "tool_verified") {
			return proposal.evidence.sampleN >= 1
				? { passed: true }
				: { passed: false, reason: "tool_verified memory requires sampleN >= 1" };
		}
		if (proposal.confidence === "inferred") {
			const distinctSessions = new Set(proposal.evidence.sessionIds).size;
			return proposal.evidence.sampleN >= 3 && distinctSessions >= 2
				? { passed: true }
				: { passed: false, reason: "inferred memory requires sampleN >= 3 and at least 2 distinct sessions" };
		}
		return { passed: false, reason: "hypothesis memory requires manual review and cannot pass provenance gate" };
	}

	if (proposal.type === "skill") {
		return proposal.sourceMemoryIds.length >= 2
			? { passed: true }
			: { passed: false, reason: "skill proposal requires at least 2 source memory ids" };
	}

	if (proposal.type === "rule") {
		return proposal.replaySessions.length >= 5
			? { passed: true }
			: { passed: false, reason: "rule proposal requires at least 5 replay sessions" };
	}

	if (proposal.type === "settings") {
		return proposal.provenance.source === "manual" || proposal.provenance.source === "rule"
			? { passed: true }
			: { passed: false, reason: "settings proposal requires manual or rule provenance" };
	}
	return { passed: false, reason: `unknown proposal type: ${(proposal as { type?: unknown }).type}` };
}
