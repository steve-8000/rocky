import type {
	EvidenceCard,
	ResearchAssessment,
	ResearchBrief,
	ResearchLane,
	RuntimeCriticCheck,
	UncertaintyMap,
	UncertaintyMapPart,
} from "./types";

export function buildUncertaintyMap(input: {
	brief: ResearchBrief;
	evidence: EvidenceCard[];
	assessment: ResearchAssessment;
	criticChecks?: RuntimeCriticCheck[];
	requiredLanes?: ResearchLane[];
}): UncertaintyMap {
	const requested = input.requiredLanes ?? input.brief.lanes;
	const laneSet = new Set(input.brief.lanes);
	const lanes = requested.filter(lane => laneSet.has(lane));
	const checks = input.criticChecks ?? [];
	const parts: UncertaintyMapPart[] = lanes.map(lane => {
		const laneEvidence = input.evidence.filter(card => card.lane === lane);
		const missingEvidence = input.assessment.incompleteLanes.includes(lane);
		const speculativeEvidenceIds = laneEvidence
			.filter(card => input.assessment.speculativeEvidenceIds.includes(card.id))
			.map(card => card.id);
		const conflictingEvidenceIds = laneEvidence
			.filter(card => input.assessment.conflictingEvidenceIds.includes(card.id))
			.map(card => card.id);
		const blockingCheckIds = checks
			.filter(check => check.lane === lane && check.severity === "blocking")
			.map(check => check.id);
		const softCheckIds = checks
			.filter(check => check.lane === lane && check.severity === "soft")
			.map(check => check.id);
		const blockers = [
			...(missingEvidence ? ["missing-evidence"] : []),
			...(speculativeEvidenceIds.length > 0 ? ["speculative-evidence"] : []),
			...(conflictingEvidenceIds.length > 0 ? ["conflicting-evidence"] : []),
			...(blockingCheckIds.length > 0 ? ["blocking-critic-check"] : []),
		];
		return {
			lane,
			required: true,
			evidenceCount: laneEvidence.length,
			missingEvidence,
			speculativeEvidenceIds,
			conflictingEvidenceIds,
			blockingCheckIds,
			softCheckIds,
			status: blockers.length > 0 ? "uncertain" : "satisfied",
			reasons: blockers,
		};
	});

	return {
		briefId: input.brief.id,
		requiredLanes: lanes,
		parts,
		blockingCheckIds: checks.filter(check => check.severity === "blocking").map(check => check.id),
		softCheckIds: checks.filter(check => check.severity === "soft").map(check => check.id),
		updatedAt: Date.now(),
	};
}
