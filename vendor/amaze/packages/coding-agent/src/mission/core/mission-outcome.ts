/**
 * Terminal status of a mission outcome.
 */
export type MissionOutcomeStatus = "success" | "partial" | "failed" | "blocked" | "cancelled" | "rolled_back";

/**
 * The final result of a mission once it reaches a terminal lifecycle state.
 */
export interface MissionOutcome {
	/** Terminal status. */
	status: MissionOutcomeStatus;
	/** Human-readable summary of what happened. */
	summary: string;
	/** References to artifacts/evidence produced by the mission. */
	evidenceRefs?: string[];
	/** Reason the mission was blocked or failed, if applicable. */
	failureReason?: string;
	/** Timestamp (epoch ms) when the outcome was recorded. */
	recordedAt: number;
}
