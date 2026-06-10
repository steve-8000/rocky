import type { RiskLevel } from "../../research/types";
import type { Mission } from "../core/mission";
import type { MissionInput } from "../core/mission-input";

/**
 * Policy-level risk taxonomy. Distinct from the core {@link RiskLevel}
 * (`low | medium | high`) in that it adds a `critical` tier for irreversible /
 * externally-visible actions (delete, deploy, calls to external systems). The
 * policy engine reasons in this richer space and then projects back down to the
 * core {@link RiskLevel} (via {@link toCoreRiskLevel}) for the Mission aggregate
 * and the `mission.classified` event, neither of which understands `critical`.
 */
export const POLICY_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type PolicyRiskLevel = (typeof POLICY_RISK_LEVELS)[number];

const RISK_ORDER: Record<PolicyRiskLevel, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

/** The minimal signal surface used to compute a mission's risk level. */
export interface MissionRiskSignals {
	/** Caller-asserted risk, if any. Acts as a floor. */
	assertedRiskLevel?: RiskLevel;
	/** Original objective text, used by intent classification. */
	objective: string;
	/** The objective + title text, lower-cased and concatenated. */
	text: string;
	/** Operating mode; `autonomous` raises the floor for mutating work. */
	autonomous: boolean;
}

/** Return the higher of two policy risk levels. */
export function maxRisk(a: PolicyRiskLevel, b: PolicyRiskLevel): PolicyRiskLevel {
	return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Numeric ordering helper for callers that want to compare thresholds. */
export function riskAtLeast(level: PolicyRiskLevel, floor: PolicyRiskLevel): boolean {
	return RISK_ORDER[level] >= RISK_ORDER[floor];
}

/** Project a policy risk level down to the core {@link RiskLevel}. */
export function toCoreRiskLevel(level: PolicyRiskLevel): RiskLevel {
	return level === "critical" ? "high" : level;
}

// Signal vocabulary. Kept deliberately small and explicit so the default policy
// table is auditable rather than a black box.
const CRITICAL_SIGNALS = [
	"delete",
	"drop ",
	"deploy",
	"rm -rf",
	"production",
	"prod ",
	"external",
	"publish",
	"release",
	"migrate",
	"truncate",
	"force push",
	"force-push",
];
const HIGH_SIGNALS = [
	"refactor",
	"architecture",
	"redesign",
	"rewrite",
	"design ",
	"security",
	"auth",
	"migration",
	"breaking",
	"schema",
];
const MUTATION_SIGNALS = [
	"fix",
	"add",
	"implement",
	"change",
	"edit",
	"write",
	"update",
	"create",
	"modify",
	"build",
	"remove",
	"rename",
	"patch",
];

/** True when the mission text implies a code/state mutation. */
export function impliesMutation(text: string): boolean {
	return MUTATION_SIGNALS.some(s => text.includes(s));
}

/** True when the mission text implies an irreversible / external action. */
export function impliesCriticalAction(text: string): boolean {
	return CRITICAL_SIGNALS.some(s => text.includes(s));
}

/**
 * Compute the policy risk level from mission signals. The caller-asserted risk
 * acts as a floor; the heuristic can only raise it. The default mapping:
 *   - critical: delete/deploy/production/external/irreversible signals
 *   - high: refactor/architecture/security/migration/breaking design work
 *   - medium: any other mutation, or autonomous mode
 *   - low: read-only / Q&A
 */
export function computeRiskLevel(signals: MissionRiskSignals): PolicyRiskLevel {
	let level: PolicyRiskLevel = signals.assertedRiskLevel ?? "low";

	if (impliesCriticalAction(signals.text)) {
		level = maxRisk(level, "critical");
	} else if (HIGH_SIGNALS.some(s => signals.text.includes(s))) {
		level = maxRisk(level, "high");
	} else if (impliesMutation(signals.text)) {
		level = maxRisk(level, "medium");
	}

	// Autonomous mutating work carries more risk than the same work done
	// interactively (no human in the loop to catch a bad step).
	if (signals.autonomous && impliesMutation(signals.text)) {
		level = maxRisk(level, "medium");
	}

	return level;
}

/** Build risk signals from a mission aggregate. */
export function riskSignalsFromMission(
	mission: Pick<Mission, "title" | "objective" | "riskLevel" | "mode">,
): MissionRiskSignals {
	return {
		assertedRiskLevel: mission.riskLevel,
		objective: mission.objective,
		text: `${mission.title}\n${mission.objective}`.toLowerCase(),
		autonomous: mission.mode === "autonomous",
	};
}

/** Build risk signals from raw mission input. */
export function riskSignalsFromInput(input: MissionInput): MissionRiskSignals {
	return {
		...(input.riskLevel !== undefined ? { assertedRiskLevel: input.riskLevel } : {}),
		objective: input.objective,
		text: `${input.title}\n${input.objective}`.toLowerCase(),
		autonomous: input.mode === "autonomous",
	};
}
