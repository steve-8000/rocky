export const RESEARCH_LANES = ["repo", "source", "social"] as const;
export type ResearchLane = (typeof RESEARCH_LANES)[number];

export const EVIDENCE_GRADES = ["A", "B", "C", "D", "E"] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface ResearchBrief {
	id: string;
	objectiveId: string | null;
	question: string;
	lanes: ResearchLane[];
	requiredEvidence: string[];
	disallowedEvidence: string[];
	riskLevel: RiskLevel;
	stopCriteria: string[];
	createdAt: number;
	updatedAt: number;
}

export type NewResearchBrief = Omit<ResearchBrief, "id" | "createdAt" | "updatedAt"> & {
	id?: string;
};

export interface EvidenceCard {
	id: string;
	briefId: string;
	lane: ResearchLane;
	grade: EvidenceGrade;
	sourceRef: string;
	excerpt: string;
	claims: string[];
	capturedAt: number;
	/** 0..1 — primary vs secondary */
	directness: number;
	/** 0..1 — concrete fact vs opinion */
	specificity: number;
	/** 0..1 — newer is higher */
	recency: number;
	/** 0..1 — can be reproduced by code/tests */
	reproducibility: number;
}

export type NewEvidenceCard = Omit<EvidenceCard, "id" | "capturedAt"> & {
	id?: string;
	capturedAt?: number;
};

export const DECISION_KINDS = ["select", "reject", "defer", "needs-more-research", "scope-reduction"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface DecisionRecord {
	id: string;
	briefId: string;
	hypothesis: string;
	rationale: string;
	kind: DecisionKind;
	confidence: ConfidenceLevel;
	evidenceRefs: string[];
	rejectedOptions: Array<{ id: string; reason: string }>;
	nextActions: string[];
	createdAt: number;
}

export type NewDecisionRecord = Omit<DecisionRecord, "id" | "createdAt" | "kind"> & {
	id?: string;
	kind?: DecisionKind;
};
export const CRITIQUE_VERDICTS = ["accept", "accept-with-modifications", "reject", "needs-more-research"] as const;
export type CritiqueVerdict = (typeof CRITIQUE_VERDICTS)[number];

export interface SynthesisRecord {
	id: string;
	briefId: string;
	hypothesisCount: number;
	recommended: string | null;
	summary: string;
	rawOutput: string;
	createdAt: number;
}

export type NewSynthesisRecord = Omit<SynthesisRecord, "id" | "createdAt"> & {
	id?: string;
	createdAt?: number;
};
export const CRITIQUE_FINDING_SEVERITIES = ["soft", "blocking"] as const;
export type CritiqueFindingSeverity = (typeof CRITIQUE_FINDING_SEVERITIES)[number];

export const CRITIQUE_FINDING_REQUIRED_ACTIONS = [
	"collect-evidence",
	"resolve-conflict",
	"run-critique",
	"defer",
] as const;
export type CritiqueFindingRequiredAction = (typeof CRITIQUE_FINDING_REQUIRED_ACTIONS)[number];

export interface CritiqueFinding {
	id: string;
	severity: CritiqueFindingSeverity;
	message: string;
	evidenceRefs: string[];
	requiredAction: CritiqueFindingRequiredAction;
}

export interface CritiqueRecord {
	id: string;
	briefId: string;
	blockingCount: number;
	softCount: number;
	verdict: CritiqueVerdict;
	summary: string;
	rawOutput: string;
	findings: CritiqueFinding[];
	createdAt: number;
}

export type NewCritiqueRecord = Omit<CritiqueRecord, "id" | "createdAt" | "findings"> & {
	id?: string;
	createdAt?: number;
	findings?: CritiqueFinding[];
};

export const RESEARCH_READINESS = [
	"insufficient",
	"researching",
	"ready-to-critique",
	"ready-to-decide",
	"blocked",
	"decided",
] as const;
export type ResearchReadiness = (typeof RESEARCH_READINESS)[number];

export const RESEARCH_NEXT_ACTIONS = [
	"collect-evidence",
	"run-synthesis",
	"run-critique",
	"record-decision",
	"defer",
	"none",
] as const;
export type ResearchNextAction = (typeof RESEARCH_NEXT_ACTIONS)[number];

export const RUNTIME_CRITIC_TRIGGERS = [
	"missing-lane-evidence",
	"speculative-evidence",
	"conflicting-evidence",
	"blocked-assessment",
	"critique-finding",
	"policy-required-evidence",
	"policy-disallowed-evidence",
	"policy-stop-criteria",
] as const;
export type RuntimeCriticTrigger = (typeof RUNTIME_CRITIC_TRIGGERS)[number];

export const RUNTIME_CRITIC_SEVERITIES = ["soft", "blocking"] as const;
export type RuntimeCriticSeverity = (typeof RUNTIME_CRITIC_SEVERITIES)[number];

export const RUNTIME_CRITIC_REQUIRED_ACTIONS = [
	"collect-evidence",
	"resolve-conflict",
	"run-critique",
	"defer",
] as const;
export type RuntimeCriticRequiredAction = (typeof RUNTIME_CRITIC_REQUIRED_ACTIONS)[number];

export interface RuntimeCriticCheck {
	id: string;
	briefId: string;
	missionId: string | null;
	lane: ResearchLane | null;
	trigger: RuntimeCriticTrigger;
	severity: RuntimeCriticSeverity;
	requiredAction: RuntimeCriticRequiredAction;
	source: "research-assessment";
	message: string;
	evidenceRefs: string[];
	createdAt: number;
}

export type NewRuntimeCriticCheck = Omit<RuntimeCriticCheck, "id" | "createdAt" | "source"> & {
	id?: string;
	createdAt?: number;
	source?: "research-assessment";
};

export interface ResearchAssessment {
	briefId: string;
	readiness: ResearchReadiness;
	incompleteLanes: ResearchLane[];
	speculativeEvidenceIds: string[];
	conflictingEvidenceIds: string[];
	blockingCount: number;
	recommendedNextAction: ResearchNextAction;
}

export interface ComplementarityScore {
	briefId: string;
	total: number;
	laneCoverage: number;
	sourceQuality: number;
	contradictionPenalty: number;
	stalenessPenalty: number;
	socialOverweightPenalty: number;
	breakdown: Array<{ lane: ResearchLane; cardCount: number; avgGradeWeight: number }>;
}

export interface UncertaintyMapPart {
	lane: ResearchLane;
	required: boolean;
	evidenceCount: number;
	missingEvidence: boolean;
	speculativeEvidenceIds: string[];
	conflictingEvidenceIds: string[];
	blockingCheckIds: string[];
	softCheckIds: string[];
	status: "satisfied" | "uncertain";
	reasons: string[];
}

export interface UncertaintyMap {
	briefId: string;
	requiredLanes: ResearchLane[];
	parts: UncertaintyMapPart[];
	blockingCheckIds: string[];
	softCheckIds: string[];
	updatedAt: number;
}
