/**
 * Mission continuation ledger types.
 *
 * Ported from OpenAI Codex's thread-goal runtime (codex-rs/core/src/goals.rs +
 * state/src/model/thread_goal.rs). Codex's `ThreadGoalStatus` becomes our
 * continuation *ledger* status — deliberately distinct from the mission
 * lifecycle enum (`MissionLifecycleState`). Mission lifecycle remains the single
 * source of lifecycle truth (see MISSION_CONTROL_LONG_RUNNING_GOALS.md normative
 * decisions #1, #2); the ledger only governs autonomous continuation scheduling.
 */

/**
 * Continuation scheduling status for a mission. These are NOT mission lifecycle
 * states; they describe whether the runtime may schedule another autonomous
 * turn for the mission.
 *
 * Mapping from Codex ThreadGoalStatus:
 *   Active        → idle | scheduled | running  (schedulable family)
 *   Paused        → paused          (user-paused; non-schedulable)
 *   Blocked       → blocked         (non-schedulable; mission may also be blocked)
 *   BudgetLimited → budget_limited  (non-schedulable; steering emitted once)
 *   UsageLimited  → usage_limited   (non-schedulable until reset)
 *   Complete      → completed       (mission completed via existing path)
 */
export const CONTINUATION_STATUSES = [
	"idle",
	"scheduled",
	"running",
	"paused",
	"blocked",
	"budget_limited",
	"usage_limited",
	"completed",
] as const;

export type ContinuationStatus = (typeof CONTINUATION_STATUSES)[number];

/** Statuses from which the runtime may schedule a new continuation turn. */
export const SCHEDULABLE_CONTINUATION_STATUSES: ReadonlySet<ContinuationStatus> = new Set(["idle"]);

/** Statuses that are sticky and never auto-resume without explicit user action. */
export const TERMINAL_CONTINUATION_STATUSES: ReadonlySet<ContinuationStatus> = new Set(["blocked", "completed"]);

/** Non-schedulable, recoverable-by-user statuses (Codex: paused/budget/usage). */
export const HELD_CONTINUATION_STATUSES: ReadonlySet<ContinuationStatus> = new Set([
	"paused",
	"budget_limited",
	"usage_limited",
]);

/**
 * Durable continuation scheduling record. Primary key is `missionId`
 * (design doc decision #5); session/branch/tree are ownership metadata, not
 * identity.
 */
export interface MissionContinuationRecord {
	missionId: string;
	/** Last session that owned/touched the continuation (ownership metadata). */
	sessionId: string | null;
	/** Owning branch for fork/branch ownership checks. */
	ownerBranch: string | null;
	/** Owning session-tree leaf id for tree ownership checks. */
	ownerTreeId: string | null;
	status: ContinuationStatus;
	/** Monotonic CAS generation. Each schedule increments it by one. */
	generation: number;
	/** Number of automatic continuation turns started (incremented on markRunning). */
	autoTurnCount: number;
	/** Token usage attributed to autonomous continuation (Codex tokens_used). */
	tokensUsed: number;
	/** Wall-clock seconds attributed to continuation (Codex time_used_seconds). */
	timeUsedSeconds: number;
	/** Observable-state fingerprint of the last completed generation. */
	progressFingerprint: string | null;
	/** Consecutive generations with an identical fingerprint (no progress). */
	noProgressCount: number;
	/** Last reason the runtime recorded for scheduling/stopping. */
	lastReason: string | null;
	lastScheduledAt: number | null;
	lastStartedAt: number | null;
	lastEndedAt: number | null;
	/** Turn id of the last continuation turn (for replay/debug). */
	lastTurnId: string | null;
	updatedAt: number;
}

/** Ownership identity for CAS ownership checks/transfers. */
export interface ContinuationOwner {
	sessionId: string | null;
	ownerBranch: string | null;
	ownerTreeId: string | null;
}

/** The hidden continuation message envelope (design doc prompt contract). */
export const MISSION_CONTINUATION_MESSAGE_TYPE = "mission-continuation";
