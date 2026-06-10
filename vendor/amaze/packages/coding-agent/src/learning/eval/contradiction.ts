import type { LearningProposal } from "../types";

export interface GateResult {
	passed: boolean;
	reason?: string;
}

export function evaluateContradictionGate(
	proposal: LearningProposal,
	opts: { existingMemoryContent?: string[]; existingSkill?: { name: string; bodyMarkdown: string } | null } = {},
): GateResult {
	if (proposal.type === "memory") {
		for (const existing of opts.existingMemoryContent ?? []) {
			if (lexicalContradictionSignal(proposal.content, existing) > 0.5) {
				return { passed: false, reason: "memory proposal contradicts existing memory content" };
			}
		}
		return { passed: true };
	}

	if (proposal.type === "skill") {
		if (opts.existingSkill?.name === proposal.name) {
			return { passed: false, reason: `skill name already exists: ${proposal.name}` };
		}
		return { passed: true };
	}

	if (proposal.type === "settings") {
		if (!hasRollback(proposal)) return { passed: false, reason: "settings proposal requires rollback patch" };
		return { passed: true };
	}

	return { passed: true };
}

function hasRollback(proposal: LearningProposal & { type: "settings" }): boolean {
	return typeof proposal.rollback === "object" && proposal.rollback !== null;
}

function lexicalContradictionSignal(next: string, existing: string): number {
	const normalizedNext = normalize(next);
	const normalizedExisting = normalize(existing);
	if (!shareMeaningfulToken(normalizedNext, normalizedExisting)) return 0;

	const nextPolarity = polarity(normalizedNext);
	const existingPolarity = polarity(normalizedExisting);
	if (nextPolarity !== 0 && existingPolarity !== 0 && nextPolarity !== existingPolarity) return 1;

	return 0;
}

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9가-힣]+/g, " ")
		.trim();
}

function shareMeaningfulToken(left: string, right: string): boolean {
	const rightTokens = new Set(right.split(/\s+/).filter(token => token.length >= 4));
	return left.split(/\s+/).some(token => token.length >= 4 && rightTokens.has(token));
}

function polarity(value: string): -1 | 0 | 1 {
	const negative =
		/\b(no|not|never|avoid|forbid|forbidden|disable|disabled|reject|without|don'?t|do not|must not)\b/.test(value);
	const positive = /\b(always|must|should|required|require|enable|enabled|allow|use|prefer)\b/.test(value);
	if (negative) return -1;
	if (positive) return 1;
	return 0;
}
