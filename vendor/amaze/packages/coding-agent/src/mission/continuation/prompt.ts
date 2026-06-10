/**
 * Continuation prompt builder. Ported from Codex goals.rs continuation_prompt /
 * budget_limit_prompt, adapted to the Mission aggregate.
 */

import { prompt } from "@amaze/utils";
import type { Mission } from "../core/mission";
import budgetLimitTemplate from "./budget-limit.md" with { type: "text" };
import continuationTemplate from "./continuation.md" with { type: "text" };
import { buildAcceptancePreflight, type MissionAutonomyProfile } from "./policy";

/** Inputs for the continuation prompt (objective is mission-provided data). */
export interface MissionContinuationPromptInput {
	mission: Mission;
	generation: number;
	autonomyProfile?: MissionAutonomyProfile;
}

function remainingTokens(mission: Mission): number {
	const budget = mission.budget.tokenBudget;
	if (!budget || budget <= 0) return 0;
	return Math.max(0, budget - mission.budget.tokensUsed);
}

/**
 * Render the hidden continuation steering message for an active mission. Names
 * the concrete unmet acceptance gates so the model continues the right work and
 * does not fabricate completion (design doc prompt contract).
 */
export function buildMissionContinuationPrompt(input: MissionContinuationPromptInput): string {
	const { mission, generation } = input;
	const preflight = buildAcceptancePreflight(mission, { autonomyProfile: input.autonomyProfile });
	return prompt.render(continuationTemplate, {
		missionId: mission.id,
		objective: mission.objective,
		lifecycle: mission.lifecycle,
		generation,
		hasMissingGates: preflight.missingGates.length > 0,
		missingGates: preflight.missingGates,
		hasUnverifiedPhases: preflight.unverifiedPhases.length > 0,
		unverifiedPhases: preflight.unverifiedPhases,
		tokensUsed: mission.budget.tokensUsed,
		tokenBudget: mission.budget.tokenBudget || "unbounded",
		remainingTokens: mission.budget.tokenBudget ? remainingTokens(mission) : "unbounded",
	});
}

/** Render the hidden budget-limit steering message (Codex budget_limit.md). */
export function buildBudgetLimitPrompt(mission: Mission, timeUsedSeconds: number): string {
	return prompt.render(budgetLimitTemplate, {
		missionId: mission.id,
		objective: mission.objective,
		tokensUsed: mission.budget.tokensUsed,
		tokenBudget: mission.budget.tokenBudget || "unbounded",
		timeUsedSeconds,
	});
}
