/**
 * A single acceptance criterion for a mission. Acceptance criteria are the
 * concrete, checkable conditions that must hold for a mission to be considered
 * successfully completed.
 */
export interface AcceptanceCriterion {
	/** Stable identifier for the criterion. */
	id: string;
	/** Human-readable description of what must be true. */
	description: string;
	/** Whether the criterion has been satisfied. */
	satisfied: boolean;
	/** How the criterion is/was verified, if known. */
	verificationMethod?: string;
	/** Free-form evidence references supporting the satisfied state. */
	evidenceRefs?: string[];
}
