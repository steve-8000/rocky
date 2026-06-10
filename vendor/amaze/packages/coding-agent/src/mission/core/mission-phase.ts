import type { AcceptanceCriterion } from "./acceptance-criteria";
import type { MissionVerification } from "./mission";

/** Lifecycle statuses for a mission phase. */
export const MISSION_PHASE_STATUSES = ["pending", "active", "verified", "failed", "rolled_back"] as const;

/** Discriminated status for a {@link MissionPhase}. */
export type MissionPhaseStatus = (typeof MISSION_PHASE_STATUSES)[number];

/** A scoped chunk of mission work with its own acceptance criteria. */
export interface MissionPhase {
	id: string;
	missionId: string;
	ordinal: number;
	name: string;
	description?: string;
	/** Plan step ids that belong to this phase. */
	planStepIds: string[];
	/** Acceptance criteria scoped to this phase. Verifier runs only these on phase close. */
	acceptanceCriteria: AcceptanceCriterion[];
	status: MissionPhaseStatus;
	/** Most recent verification of this phase, if any. */
	verification?: MissionVerification;
	createdAt: number;
	updatedAt: number;
	closedAt?: number;
}

/** Caller-supplied shape for declaring a mission phase. */
export interface MissionPhaseInput {
	id?: string;
	ordinal: number;
	name: string;
	description?: string;
	planStepIds?: string[];
	acceptanceCriteria?: AcceptanceCriterion[];
}
