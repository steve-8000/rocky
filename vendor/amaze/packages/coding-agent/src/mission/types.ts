import type { ConfidenceLevel, ResearchLane, RiskLevel } from "../research/types";

export const MISSION_STATES = [
	"drafting",
	"researching",
	"synthesizing",
	"critiquing",
	"deciding",
	"contracted",
	"executing",
	"verifying",
	"completed",
	"rolled_back",
	"blocked",
	"cancelled",
] as const;
export type MissionState = (typeof MISSION_STATES)[number];

export const EPISTEMIC_ROLES = ["repo_truth", "source_harvest", "social_signal", "synthesis", "critic"] as const;
export type EpistemicRole = (typeof EPISTEMIC_ROLES)[number];

export const MISSION_LANE_STATUSES = ["pending", "running", "completed", "empty", "failed", "aborted"] as const;
export const RESEARCH_RUN_STATUSES = ["running", "completed", "blocked", "cancelled"] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export type MissionLaneStatus = (typeof MISSION_LANE_STATUSES)[number];

/**
 * Research campaign read-model record (formerly named `Mission`). This is the
 * research/epistemic side — brief, lanes, evidence, decision, confidence — and is
 * intentionally distinct from the objective-execution {@link ../core/mission.Mission}
 * aggregate. Renamed to free the bare name `Mission` for the objective runtime.
 */
export interface ResearchCampaign {
	id: string;
	title: string;
	objectiveId: string | null;
	briefId: string | null;
	decisionId: string | null;
	riskLevel: RiskLevel;
	state: MissionState;
	confidence: ConfidenceLevel | null;
	snapshotRef: string | null;
	createdAt: number;
	updatedAt: number;
	revision: number;
	/**
	 * Durable core-mission pointers (workplan: durable Mission aggregate). These mirror the
	 * rich {@link core/mission.Mission} fields the policy/close gates read, so they survive a
	 * session restart instead of living only in the in-memory runtime map. Persisted as plain
	 * strings; the core runtime casts them back to their union types on hydrate.
	 */
	intent?: string | null;
	lifecycle?: string | null;
	proposalId?: string | null;
	regressionContractId?: string | null;
}

export type NewResearchCampaign = Omit<ResearchCampaign, "id" | "createdAt" | "updatedAt" | "revision"> & {
	id?: string;
	revision?: number;
};

export interface MissionLaneRun {
	id: string;
	missionId: string;
	lane: ResearchLane;
	agent: string;
	epistemicRole: EpistemicRole;
	status: MissionLaneStatus;
	evidenceCount: number;
	emptyReason: string | null;
	taskId: string | null;
	startedAt: number | null;
	endedAt: number | null;
}

export type NewMissionLaneRun = Omit<MissionLaneRun, "id"> & {
	id?: string;
};

export interface ResearchRun {
	id: string;
	missionId: string;
	briefId: string;
	objectiveId: string | null;
	status: ResearchRunStatus;
	startedAt: number;
	completedAt: number | null;
}

export type NewResearchRun = Omit<ResearchRun, "id" | "startedAt"> & {
	id?: string;
	startedAt?: number;
};
export interface MissionContractRecord {
	id: string;
	missionId: string;
	role: string;
	parentMissionRev: number | null;
	include: string[];
	exclude: string[];
	successCriteria: string[];
	escalation: { onUncertainty: "ask-parent" | "block"; budgetCap: number };
	inputArtifact: string | null;
	mustProduce: string[];
	taskId: string | null;
	sessionFile: string | null;
	createdAt: number;
}

export type TaskAttemptFailureMode =
	| "contract-fail"
	| "contract-uncertain"
	| "executor-error"
	| "aborted"
	| "interrupted";
export type TaskAttemptStatus = "running" | "failed" | "blocked" | "escalated" | "completed";
export type TaskAttemptRemediationAction = "retry" | "resume" | "escalate" | "block";

export interface MissionTaskAttemptCheckpoint {
	id: string;
	missionId: string;
	taskId: string;
	agent: string;
	role: string;
	attempt: number;
	status: TaskAttemptStatus;
	failureMode: TaskAttemptFailureMode | null;
	lastVerdict: "pass" | "fail" | "uncertain" | null;
	failedCount: number;
	uncertainCount: number;
	remediationAction: TaskAttemptRemediationAction;
	sessionFile: string | null;
	artifactRefs: string[];
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export type NewMissionTaskAttemptCheckpoint = Omit<MissionTaskAttemptCheckpoint, "id" | "createdAt" | "updatedAt"> & {
	id?: string;
	createdAt?: number;
	updatedAt?: number;
};

export type NewMissionContractRecord = Omit<MissionContractRecord, "id" | "createdAt" | "taskId" | "sessionFile"> & {
	id?: string;
	createdAt?: number;
	taskId?: string | null;
	sessionFile?: string | null;
};

export interface MissionPhaseRecord {
	id: string;
	missionId: string;
	ordinal: number;
	name: string;
	description: string | null;
	status: "pending" | "active" | "verified" | "failed" | "rolled_back";
	planStepIds: string[];
	acceptanceCriteriaJson: string;
	createdAt: number;
	updatedAt: number;
	closedAt: number | null;
}

export type NewMissionPhaseRecord = Omit<MissionPhaseRecord, "id" | "createdAt" | "updatedAt"> & {
	id?: string;
	createdAt?: number;
	updatedAt?: number;
};

export interface MissionPhaseVerificationRecord {
	id: string;
	missionId: string;
	phaseId: string;
	status: "pass" | "fail" | "uncertain" | "force";
	failedCount: number;
	uncertainCount: number;
	summary: string;
	createdAt: number;
}

export type NewMissionPhaseVerificationRecord = Omit<MissionPhaseVerificationRecord, "id" | "createdAt"> & {
	id?: string;
	createdAt?: number;
};

export interface MissionVerificationRecord {
	id: string;
	missionId: string;
	status: "pass" | "fail" | "uncertain" | "force";
	failedCount: number;
	uncertainCount: number;
	summary: string;
	createdAt: number;
}

export type NewMissionVerificationRecord = Omit<MissionVerificationRecord, "id" | "createdAt"> & {
	id?: string;
	createdAt?: number;
};

export interface MissionReviewRecord {
	id: string;
	missionId: string;
	status: "pass" | "fail" | "uncertain";
	verdict: "pass" | "fail" | "pending";
	failedCount: number;
	uncertainCount: number;
	summary: string;
	sourceFiles: string[];
	excludedMarkdownFiles: string[];
	createdAt: number;
	reviewedAt: number;
}

export type NewMissionReviewRecord = Omit<MissionReviewRecord, "id" | "createdAt"> & {
	id?: string;
	createdAt?: number;
};

export interface MissionRollbackRecord {
	id: string;
	missionId: string;
	targetType: "decision" | "proposal" | "file";
	targetId: string;
	snapshotRef: string | null;
	summary: string;
	createdAt: number;
}

export type NewMissionRollbackRecord = Omit<MissionRollbackRecord, "id" | "createdAt"> & {
	id?: string;
	createdAt?: number;
};

export type CriticDialogueRole = "orchestrator" | "inner-critic";

export interface MissionCriticDialogueTurn {
	id: string;
	missionId: string;
	role: CriticDialogueRole;
	summary: string;
	checkIds: string[];
	createdAt: number;
}

export type NewMissionCriticDialogueTurn = Omit<MissionCriticDialogueTurn, "id" | "createdAt"> & {
	id?: string;
	createdAt?: number;
};

export type MissionWorldModelRecordKind = "claim" | "action" | "outcome" | "critic";
export type MissionWorldModelRecordSource = "decision" | "evidence" | "task-attempt" | "verification" | "critic";
export type MissionWorldModelLinkType = "supports" | "contradicts" | "evidence-for" | "outcome-of";

export interface MissionWorldModelLink {
	targetId: string;
	type: MissionWorldModelLinkType;
}

export interface MissionWorldModelRecord {
	id: string;
	missionId: string;
	kind: MissionWorldModelRecordKind;
	source: MissionWorldModelRecordSource;
	sourceId: string;
	claim: string;
	evidenceRefs: string[];
	links: MissionWorldModelLink[];
	outcomeStatus: "pass" | "fail" | "uncertain" | "blocked" | null;
	verified: boolean;
	createdAt: number;
}

export type NewMissionWorldModelRecord = Omit<
	MissionWorldModelRecord,
	"id" | "createdAt" | "links" | "outcomeStatus"
> & {
	id?: string;
	createdAt?: number;
	links?: MissionWorldModelLink[];
	outcomeStatus?: MissionWorldModelRecord["outcomeStatus"];
};

export interface MissionPolicyGuidance {
	missionId: string;
	verifiedOutcomeCount: number;
	recommendedAgents: string[];
	retryPolicy: "standard" | "retry-on-contract-fail" | "escalate-on-failure";
	laneMix: string[];
	rationale: string[];
}
