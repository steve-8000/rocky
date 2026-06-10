import type { LearningProposal } from "../learning";
import { AMAZE_SETTINGS_PATH, DEFAULT_AUTONOMY_FORBIDDEN_SCOPES } from "./guardrails";
import type { Objective } from "./types";

export interface ProposalHistory {
	todayCount: number;
	usedTokens: number;
	usedUsdCents?: number;
}

export interface ProposalLimitOptions {
	forbiddenScopes?: string[];
}

export interface ProposalLimitDecision {
	allow: boolean;
	reason?: string;
}

export { DEFAULT_AUTONOMY_FORBIDDEN_SCOPES as DEFAULT_FORBIDDEN_SCOPES } from "./guardrails";

export function shouldEmitProposal(
	objective: Objective,
	candidate: LearningProposal,
	history: ProposalHistory,
	opts: ProposalLimitOptions = {},
): ProposalLimitDecision {
	const maxPerDay = objective.guardrails.maxAutoSubgoalsPerDay;
	if (history.todayCount >= maxPerDay) {
		return { allow: false, reason: `daily subgoal limit reached (${history.todayCount}/${maxPerDay})` };
	}

	if (objective.budget.tokens !== undefined && history.usedTokens >= objective.budget.tokens) {
		return { allow: false, reason: `token budget exhausted (${history.usedTokens}/${objective.budget.tokens})` };
	}

	const usedUsdCents = history.usedUsdCents ?? 0;
	if (objective.budget.usd !== undefined && usedUsdCents >= Math.round(objective.budget.usd * 100)) {
		return {
			allow: false,
			reason: `usd budget exhausted (${usedUsdCents}/${Math.round(objective.budget.usd * 100)} cents)`,
		};
	}

	const scopes = opts.forbiddenScopes ?? objective.guardrails.forbiddenScopes ?? DEFAULT_AUTONOMY_FORBIDDEN_SCOPES;
	const forbiddenPath = candidateTargetPaths(candidate).find(targetPath =>
		scopes.some(pattern => globMatches(pattern, targetPath)),
	);
	if (forbiddenPath) {
		return { allow: false, reason: `candidate targets forbidden scope: ${forbiddenPath}` };
	}

	return { allow: true };
}

function candidateTargetPaths(candidate: LearningProposal): string[] {
	if (candidate.type === "settings") {
		return [AMAZE_SETTINGS_PATH, ...Object.keys(candidate.patch).map(key => `settings:${key}`)];
	}
	if (candidate.type === "rule") return [".amaze/rules/**"];
	if (candidate.type === "skill") return [`.amaze/skills/${candidate.name}/SKILL.md`];
	return [];
}

function globMatches(pattern: string, value: string): boolean {
	return globToRegExp(pattern).test(value);
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				const next = pattern[i + 2];
				if (next === "/") {
					source += "(?:.*\\/)?";
					i += 2;
				} else {
					source += ".*";
					i += 1;
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegExp(char);
	}
	return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
