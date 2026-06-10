import type { MissionContextBudget } from "./policy-decision";
import type { PolicyRiskLevel } from "./risk";

/** Inputs that shape the derived context budget. */
export interface ContextBudgetSignals {
	riskLevel: PolicyRiskLevel;
	requiresWeb: boolean;
	requiresCodebase: boolean;
	requiresMemory: boolean;
	requiresResearch: boolean;
}

// Base ceilings by risk. Higher-risk missions warrant pulling in more context
// to reason carefully; trivial Q&A stays lean.
const BASE_INPUT_TOKENS: Record<PolicyRiskLevel, number> = {
	low: 8_000,
	medium: 24_000,
	high: 64_000,
	critical: 96_000,
};

/**
 * Derive the policy's recommended context budget from the decision signals.
 * Sources that the mission does not require collapse to zero so the runtime
 * does not waste the window assembling context it will not use.
 */
export function deriveContextBudget(signals: ContextBudgetSignals): MissionContextBudget {
	const research = signals.requiresResearch;
	return {
		maxInputTokens: BASE_INPUT_TOKENS[signals.riskLevel],
		maxMemoryItems: signals.requiresMemory ? (research ? 24 : 8) : 0,
		maxFiles: signals.requiresCodebase ? (research ? 40 : 12) : 0,
		maxWebSources: signals.requiresWeb ? (research ? 12 : 4) : 0,
	};
}
