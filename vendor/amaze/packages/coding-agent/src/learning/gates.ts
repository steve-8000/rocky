import type { ProposalStore } from "./store";
import type { LearningProposal, ProposalGate } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultGate(type: LearningProposal["type"], proposal: Partial<LearningProposal>): ProposalGate {
	if (type === "memory") {
		return proposal.type === "memory" && proposal.confidence === "tool_verified" ? "auto" : "review";
	}
	if (type === "settings") {
		return "human-required";
	}
	return "review";
}

export function defaultExpiresAt(now: number, days = 14): number {
	return now + days * DAY_MS;
}

export function expirePending(store: ProposalStore, now = Date.now()): number {
	let expired = 0;
	for (const proposal of store.listByStatus("pending")) {
		if (proposal.expiresAt !== undefined && proposal.expiresAt < now) {
			store.markExpired(proposal.id);
			expired += 1;
		}
	}
	return expired;
}
