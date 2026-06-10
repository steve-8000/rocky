import type { ConfidenceLevel } from "../../research/types";
import type { MissionEventBus } from "../event-bus";
import type { MissionClassifiedEvent } from "../events";
import type { MissionPolicyDecision } from "./policy-decision";
import { toCoreRiskLevel } from "./risk";

/** Anything that can accept a {@link MissionClassifiedEvent}. */
export interface PolicyEventEmitter {
	emit(event: MissionClassifiedEvent): void;
}

/**
 * The canonical `mission.classified` event carries `riskLevel` (core taxonomy)
 * and `confidence`. The richer {@link MissionPolicyDecision} is projected onto
 * it: the policy `critical` tier collapses to core `high`. Confidence is
 * `high` only for a clean low-risk read-only decision; otherwise left null so
 * downstream consumers do not over-trust a heuristic verdict.
 */
export function policyDecisionConfidence(decision: MissionPolicyDecision): ConfidenceLevel | null {
	if (decision.riskLevel === "low" && !decision.requiresApproval && !decision.requiresCritic) {
		return "high";
	}
	return null;
}

/** Build the `mission.classified` event for a policy decision. */
export function toClassifiedEvent(
	missionId: string,
	decision: MissionPolicyDecision,
	ts: number,
): MissionClassifiedEvent {
	return {
		type: "mission.classified",
		missionId,
		riskLevel: toCoreRiskLevel(decision.riskLevel),
		confidence: policyDecisionConfidence(decision),
		ts,
	};
}

/**
 * Record a policy decision by emitting the canonical `mission.classified`
 * event on the supplied bus/emitter. Optional + injected: the runtime CAN call
 * this, but is not required to. Returns the emitted event for inspection.
 */
export function recordPolicyDecision(
	emitter: PolicyEventEmitter | MissionEventBus,
	missionId: string,
	decision: MissionPolicyDecision,
	ts: number = Date.now(),
): MissionClassifiedEvent {
	const event = toClassifiedEvent(missionId, decision, ts);
	emitter.emit(event);
	return event;
}
