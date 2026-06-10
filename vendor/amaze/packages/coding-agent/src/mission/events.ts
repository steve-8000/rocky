import type { ConfidenceLevel, EvidenceGrade, ResearchLane, RiskLevel } from "../research/types";
import type {
	EpistemicRole,
	MissionLaneStatus,
	MissionRollbackRecord,
	MissionState,
	MissionVerificationRecord,
} from "./types";

export type ResearchBriefCreatedEvent = {
	type: "research.brief.created";
	missionId: string;
	briefId: string;
	objectiveId: string | null;
	lanes: ResearchLane[];
	ts: number;
};

export type ResearchLaneStartedEvent = {
	type: "research.lane.started";
	missionId: string;
	laneRunId: string;
	lane: ResearchLane;
	agent: string;
	epistemicRole: EpistemicRole;
	ts: number;
};

export type ResearchLaneCompletedEvent = {
	type: "research.lane.completed";
	missionId: string;
	laneRunId: string;
	lane: ResearchLane;
	status: MissionLaneStatus;
	evidenceCount: number;
	emptyReason: string | null;
	ts: number;
};

export type ResearchEvidenceAddedEvent = {
	type: "research.evidence.added";
	missionId: string;
	briefId: string;
	evidenceId: string;
	lane: ResearchLane;
	grade: EvidenceGrade;
	ts: number;
};

export type ResearchSynthesisProposedEvent = {
	type: "research.synthesis.proposed";
	missionId: string;
	briefId: string;
	hypothesisCount: number;
	recommended: string | null;
	ts: number;
};

export type ResearchCritiqueCompletedEvent = {
	type: "research.critique.completed";
	missionId: string;
	briefId: string;
	blockingCount: number;
	softCount: number;
	verdict: "accept" | "accept-with-modifications" | "reject" | "needs-more-research";
	ts: number;
};

export type RuntimeCriticChecksCompletedEvent = {
	type: "runtime_critic.checks.completed";
	missionId: string;
	briefId: string;
	blockingCount: number;
	softCount: number;
	ts: number;
};

export type RuntimeCriticDialogueCompletedEvent = {
	type: "runtime_critic.dialogue.completed";
	missionId: string;
	turnIds: string[];
	blockingCheckIds: string[];
	ts: number;
};

export type DecisionRecordedEvent = {
	type: "decision.recorded";
	missionId: string;
	briefId: string;
	decisionId: string;
	confidence: ConfidenceLevel;
	ts: number;
};

export type ContractCreatedEvent = {
	type: "contract.created";
	missionId: string;
	contractId: string;
	role: string;
	ts: number;
};

export type VerificationCompletedEvent = {
	type: "verification.completed";
	missionId: string;
	verificationId: string;
	status: MissionVerificationRecord["status"];
	failedCount: number;
	uncertainCount: number;
	ts: number;
};

export type RollbackSnapshotCreatedEvent = {
	type: "rollback.snapshot.created";
	missionId: string;
	rollbackId: string;
	targetType: MissionRollbackRecord["targetType"];
	targetId: string;
	snapshotRef: string | null;
	ts: number;
};

// ---------------------------------------------------------------------------
// Event Schema v2 — mission lifecycle events (additive, workplan §12)
// ---------------------------------------------------------------------------

export type MissionCreatedEvent = {
	type: "mission.created";
	missionId: string;
	title: string;
	objectiveId: string | null;
	riskLevel: RiskLevel;
	ts: number;
};

export type MissionClassifiedEvent = {
	type: "mission.classified";
	missionId: string;
	riskLevel: RiskLevel;
	confidence: ConfidenceLevel | null;
	ts: number;
};

export type MissionPlannedEvent = {
	type: "mission.planned";
	missionId: string;
	taskCount: number;
	ts: number;
};

export type MissionProposalAttachedEvent = {
	type: "mission.proposal.attached";
	missionId: string;
	proposalId: string;
	/** Optional pointer to the artifact backing the proposal (e.g. a plan file URL). */
	planRef: string | null;
	ts: number;
};

export type MissionTaskCreatedEvent = {
	type: "mission.task.created";
	missionId: string;
	taskId: string;
	role: string;
	agent: string | null;
	ts: number;
};

export type MissionTaskCompletedEvent = {
	type: "mission.task.completed";
	missionId: string;
	taskId: string;
	status: "completed" | "failed" | "blocked" | "escalated";
	ts: number;
};

export type MissionTaskFailedEvent = {
	type: "mission.task.failed";
	missionId: string;
	taskId: string;
	status: "failed";
	ts: number;
};

export type MissionTaskAttemptEvent = {
	type: "mission.task.attempt";
	missionId: string;
	taskId: string;
	verdict: "success" | "failure";
	note?: string;
	ts: number;
};

export type MissionToolRequestedEvent = {
	type: "mission.tool.requested";
	missionId: string;
	taskId: string | null;
	toolCallId: string;
	tool: string;
	ts: number;
};

export type MissionToolCompletedEvent = {
	type: "mission.tool.completed";
	missionId: string;
	taskId: string | null;
	toolCallId: string;
	tool: string;
	status: "ok" | "error" | "denied";
	ts: number;
};

export type MissionEvidenceAddedEvent = {
	type: "mission.evidence.added";
	missionId: string;
	evidenceId: string;
	grade: EvidenceGrade;
	source: string | null;
	ts: number;
};

export type MissionCriticCompletedEvent = {
	type: "mission.critic.completed";
	missionId: string;
	blockingCount: number;
	softCount: number;
	verdict: "pass" | "fail" | "uncertain";
	ts: number;
};

export type MissionVerificationCompletedEvent = {
	type: "mission.verification.completed";
	missionId: string;
	verificationId: string;
	status: MissionVerificationRecord["status"];
	failedCount: number;
	uncertainCount: number;
	ts: number;
};

export type MissionPhaseDeclaredEvent = {
	type: "mission.phase.declared";
	missionId: string;
	phaseId: string;
	ordinal: number;
	name: string;
	ts: number;
};

export type MissionPhaseVerifiedEvent = {
	type: "mission.phase.verified";
	missionId: string;
	phaseId: string;
	verificationId: string;
	status: "pass" | "fail" | "uncertain" | "force";
	failedCount: number;
	uncertainCount: number;
	ts: number;
};

export type MissionPhaseClosedEvent = {
	type: "mission.phase.closed";
	missionId: string;
	phaseId: string;
	ts: number;
};

export type MissionCompletedEvent = {
	type: "mission.completed";
	missionId: string;
	finalState: MissionState;
	ts: number;
};

export type MissionBlockedEvent = {
	type: "mission.blocked";
	missionId: string;
	reason: string;
	ts: number;
};

export type MissionCancelledEvent = {
	type: "mission.cancelled";
	missionId: string;
	reason: string | null;
	ts: number;
};

export type MissionRolledBackEvent = {
	type: "mission.rolled_back";
	missionId: string;
	rollbackId: string;
	targetType: MissionRollbackRecord["targetType"];
	targetId: string;
	ts: number;
};

export type MissionLifecycleEvent =
	| MissionCreatedEvent
	| MissionClassifiedEvent
	| MissionPlannedEvent
	| MissionProposalAttachedEvent
	| MissionTaskCreatedEvent
	| MissionTaskCompletedEvent
	| MissionTaskFailedEvent
	| MissionTaskAttemptEvent
	| MissionToolRequestedEvent
	| MissionToolCompletedEvent
	| MissionEvidenceAddedEvent
	| MissionCriticCompletedEvent
	| MissionVerificationCompletedEvent
	| MissionCompletedEvent
	| MissionPhaseDeclaredEvent
	| MissionPhaseVerifiedEvent
	| MissionPhaseClosedEvent
	| MissionBlockedEvent
	| MissionCancelledEvent
	| MissionRolledBackEvent;

export type MissionEvent =
	| ResearchBriefCreatedEvent
	| ResearchLaneStartedEvent
	| ResearchLaneCompletedEvent
	| ResearchEvidenceAddedEvent
	| ResearchSynthesisProposedEvent
	| ResearchCritiqueCompletedEvent
	| RuntimeCriticChecksCompletedEvent
	| RuntimeCriticDialogueCompletedEvent
	| DecisionRecordedEvent
	| ContractCreatedEvent
	| VerificationCompletedEvent
	| RollbackSnapshotCreatedEvent
	| MissionLifecycleEvent;

// ---------------------------------------------------------------------------
// Versioned envelope + dual-read normalization (workplan §12)
// ---------------------------------------------------------------------------

/** Schema version of a persisted mission event record. */
export type EventSchemaVersion = 1 | 2;

/**
 * Versioned wrapper around a {@link MissionEvent}. v2 records persist a small
 * amount of envelope metadata alongside the event payload. v1 records are the
 * legacy unversioned flat events (the event object written directly to JSONL).
 */
export type EventEnvelope<T extends MissionEvent = MissionEvent> = {
	id: string;
	version: EventSchemaVersion;
	timestamp: number;
	missionId: string;
	sessionId?: string;
	event: T;
};

/** A persisted record may be a legacy flat v1 event or a v2 envelope. */
export type PersistedEventRecord = MissionEvent | EventEnvelope;

function isMissionEvent(value: unknown): value is MissionEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		typeof (value as { missionId?: unknown }).missionId === "string"
	);
}

/** True when the record is an explicit v2 envelope (has a nested `event`). */
export function isEventEnvelope(value: unknown): value is EventEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { version?: unknown }).version === 2 &&
		isMissionEvent((value as { event?: unknown }).event)
	);
}

let envelopeCounter = 0;

function nextEnvelopeId(ts: number): string {
	envelopeCounter = (envelopeCounter + 1) % 1_000_000;
	return `evt-${ts.toString(36)}-${envelopeCounter.toString(36)}`;
}

/**
 * Wrap a {@link MissionEvent} in a v2 {@link EventEnvelope}. Used by writers
 * that opt into the versioned format. The event payload is preserved verbatim,
 * so existing flat-event readers can still read `envelope.event`.
 */
export function toEventEnvelope<T extends MissionEvent>(
	event: T,
	opts: { id?: string; sessionId?: string } = {},
): EventEnvelope<T> {
	const timestamp = event.ts;
	return {
		id: opts.id ?? nextEnvelopeId(timestamp),
		version: 2,
		timestamp,
		missionId: event.missionId,
		...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
		event,
	};
}

/**
 * Dual-read normalization: accept either a legacy v1 flat event or a v2
 * envelope and return a normalized {@link EventEnvelope}. Existing JSONL
 * records (flat events) are upgraded in-memory to a v1 envelope without
 * mutating the on-disk shape.
 */
export function readEnvelope(record: PersistedEventRecord): EventEnvelope {
	if (isEventEnvelope(record)) {
		return record;
	}
	if (isMissionEvent(record)) {
		return {
			id: nextEnvelopeId(record.ts),
			version: 1,
			timestamp: record.ts,
			missionId: record.missionId,
			event: record,
		};
	}
	throw new Error("readEnvelope: record is neither a v1 mission event nor a v2 envelope");
}

/**
 * Normalize a persisted record down to its bare {@link MissionEvent}, reading
 * through both v1 (flat) and v2 (envelope) shapes. Use this in readers that
 * only care about the event payload.
 */
export function readMissionEvent(record: PersistedEventRecord): MissionEvent {
	return readEnvelope(record).event;
}
