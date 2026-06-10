/**
 * Pure continuation policy.
 *
 * Ported from OpenAI Codex's goal runtime decision logic (goals.rs continuation
 * scheduling + completion audit) and the acceptance gates currently embedded in
 * `MissionRuntimeImpl.complete`. Everything here is a pure function so it is unit
 * testable in isolation (design doc: classifyContinuation, buildAcceptancePreflight,
 * progressFingerprint).
 */

import { templateFor } from "../core/lifecycle-template";
import type { Mission, MissionLifecycleState, MissionReview, MissionVerification } from "../core/mission";
import type { ContinuationStatus, MissionContinuationRecord } from "./types";

export const MISSION_AUTONOMY_PROFILES = ["manual", "balanced", "autonomous", "strict"] as const;
export type MissionAutonomyProfile = (typeof MISSION_AUTONOMY_PROFILES)[number];

/** Mission lifecycle states that are terminal and never auto-resume. */
export const TERMINAL_LIFECYCLES: ReadonlySet<MissionLifecycleState> = new Set([
	"completed",
	"blocked",
	"cancelled",
	"rolled_back",
]);

/** Normalize a verification record to its effective verdict (mirror of runtime). */
export function verificationVerdict(
	verification: MissionVerification | undefined,
): MissionVerification["verdict"] | undefined {
	if (!verification) return undefined;
	if (verification.verdict) return verification.verdict;
	if (verification.status === "pass" || verification.status === "force") return "pass";
	if (verification.status === "fail") return "fail";
	return "pending";
}

/** Normalize a source-review record to its effective verdict. */
export function reviewVerdict(review: MissionReview | undefined): MissionReview["verdict"] | undefined {
	if (!review) return undefined;
	return review.verdict;
}

function nonMarkdownSourceCount(files: string[] | undefined): number {
	return files?.filter(path => !/\.md$/i.test(path.trim())).length ?? 0;
}

const REVIEW_REQUIRED_INTENTS = new Set<Mission["intent"]>([
	"architecture_change",
	"runtime_refactor",
	"release_hardening",
]);

export interface MissionAcceptancePolicy {
	autonomyProfile?: MissionAutonomyProfile;
	requireReview?: boolean;
}

function shouldRequireReview(mission: Mission, policy: MissionAcceptancePolicy): boolean {
	if (policy.requireReview !== undefined) return policy.requireReview;
	const profile = policy.autonomyProfile ?? "balanced";
	if (profile === "strict") {
		return templateFor(mission.intent ?? "conversation").requireReview === true;
	}
	return mission.riskLevel === "high" || REVIEW_REQUIRED_INTENTS.has(mission.intent);
}

/**
 * Result of the shared acceptance preflight. Mirrors the gate checks inside
 * `MissionRuntimeImpl.complete` WITHOUT throwing, so the continuation runtime can
 * decide to continue vs. complete vs. block from the same source of truth.
 */
export interface MissionAcceptancePreflight {
	/** True when the mission satisfies every completion gate. */
	passes: boolean;
	/** Human-readable names of the unmet gates (e.g. "decisionId", "verification.verdict=pass"). */
	missingGates: string[];
	/** Unverified phase names, if any. */
	unverifiedPhases: string[];
	/** True when a verifier recorded a hard failing verdict (work to continue, not a block). */
	failingVerdict: boolean;
}

/**
 * Compute the acceptance preflight for a mission. This is the single source of
 * truth for "may this mission complete?" shared by manual completion and the
 * continuation runtime (design doc completion semantics: only one acceptance
 * policy).
 */
export function buildAcceptancePreflight(
	mission: Mission,
	policy: MissionAcceptancePolicy = {},
): MissionAcceptancePreflight {
	const template = templateFor(mission.intent ?? "conversation");
	const missingGates: string[] = [];
	if (template.requireDecisionRecord && !mission.decisionId) missingGates.push("decisionId");
	if (template.requireRegressionContract && !mission.regressionContractId) {
		missingGates.push("regressionContractId");
	}
	const verdict = verificationVerdict(mission.verification);
	if (template.requireVerification && verdict !== "pass") {
		missingGates.push("verification.verdict=pass");
	}
	if (
		shouldRequireReview(mission, policy) &&
		(reviewVerdict(mission.review) !== "pass" || nonMarkdownSourceCount(mission.review?.sourceFiles) === 0)
	) {
		missingGates.push("review.verdict=pass");
	}
	const unverifiedPhases = (mission.phases ?? []).filter(p => p.status !== "verified").map(p => p.name);
	const force = mission.verification?.status === "force";
	const failingVerdict = !force && verdict === "fail";
	const passes = missingGates.length === 0 && unverifiedPhases.length === 0 && !failingVerdict;
	return { passes, missingGates, unverifiedPhases, failingVerdict };
}

/** The action the continuation runtime should take after a turn. */
export type ContinuationAction =
	/** No mission / not eligible / no schedulable owner — stop. */
	| { kind: "none"; reason: string }
	/** Mission lifecycle is terminal — mark ledger terminal and stop. */
	| { kind: "observe-terminal"; status: ContinuationStatus; reason: string }
	/** Pending user input — yield to the user; do not schedule. */
	| { kind: "hold"; status: ContinuationStatus; reason: string }
	/** Schedule a continuation turn instructing the agent to record completion. */
	| { kind: "continue"; reason: "record_completion" | "missing_requirements" }
	/** A real external prerequisite is missing — mark blocked. */
	| { kind: "block"; reason: string };

/** Inputs to {@link classifyContinuation}. Pure data; no IO. */
export interface ContinuationDecisionInput {
	mission: Mission | undefined;
	record: MissionContinuationRecord | undefined;
	/** True when a user-authored message is queued (user intent has priority). */
	hasPendingUserMessage: boolean;
	/** True when the active mission still needs an approved proposal before mutation. */
	needsProposal: boolean;
	/** Per-mission max automatic continuation turns. <= 0 disables the cap. */
	maxAutoTurns: number;
	/** Consecutive no-progress generations before pausing. <= 0 disables. */
	noProgressLimit: number;
	/** Active autonomy profile for risk-adaptive acceptance gates. Defaults to balanced. */
	autonomyProfile?: MissionAutonomyProfile;
}

/**
 * Decide what the continuation runtime should do after an agent turn ends.
 *
 * Mirrors the Codex continuation gate ordering (goals.rs maybe_start /
 * account_thread_goal) adapted to mission acceptance semantics. Pure: callers
 * perform IO (ledger CAS, sendMessage) based on the returned action.
 */
export function classifyContinuation(input: ContinuationDecisionInput): ContinuationAction {
	const { mission, record, hasPendingUserMessage, needsProposal, maxAutoTurns, noProgressLimit, autonomyProfile } =
		input;

	if (!mission) return { kind: "none", reason: "no_active_mission" };

	if (TERMINAL_LIFECYCLES.has(mission.lifecycle)) {
		const status: ContinuationStatus = mission.lifecycle === "completed" ? "completed" : "blocked";
		return { kind: "observe-terminal", status, reason: `mission_${mission.lifecycle}` };
	}

	// Ambient auto-promoted missions are not eligible for hidden continuation.
	// Explicit mission commands/create flows use interactive/autonomous modes.
	if (mission.mode === "auto") return { kind: "none", reason: "auto_mission_not_continuable" };

	// Sticky non-schedulable ledger statuses survive until user/policy changes them.
	if (record?.status === "paused") return { kind: "hold", status: "paused", reason: "continuation_paused" };
	if (record?.status === "budget_limited") {
		return { kind: "hold", status: "budget_limited", reason: "budget_limited" };
	}
	if (record?.status === "usage_limited") {
		return { kind: "hold", status: "usage_limited", reason: "usage_limited" };
	}

	// User intent has priority (design principle #4).
	if (hasPendingUserMessage) return { kind: "hold", status: "idle", reason: "user_message_pending" };

	// Proposal gate: a mutation-gated mission cannot continue autonomously until a
	// proposal is approved; that approval is a user action.
	if (needsProposal) return { kind: "hold", status: "idle", reason: "awaiting_proposal_approval" };

	// Budget cap on automatic turns (runaway protection).
	if (maxAutoTurns > 0 && (record?.autoTurnCount ?? 0) >= maxAutoTurns) {
		return { kind: "hold", status: "budget_limited", reason: "max_auto_turns" };
	}

	// No-progress limit: pause rather than loop forever (design doc default 3).
	if (noProgressLimit > 0 && (record?.noProgressCount ?? 0) >= noProgressLimit) {
		return { kind: "hold", status: "paused", reason: "no_progress_limit" };
	}

	const preflight = buildAcceptancePreflight(mission, { autonomyProfile });
	if (preflight.passes) {
		// Acceptance is satisfied but no terminal outcome exists yet. Per the design
		// doc, the runtime must NOT fabricate an outcome — it schedules a turn whose
		// only required next step is to record completion through the existing path.
		if (!mission.outcome) return { kind: "continue", reason: "record_completion" };
		return { kind: "none", reason: "awaiting_completion_record" };
	}

	// Failing verifier verdict or missing gates/phases is WORK to continue, not a
	// block (design doc: verification failure is work; unavailable prerequisite is a block).
	return { kind: "continue", reason: "missing_requirements" };
}

/**
 * Build the observable-state progress fingerprint for a mission. Codex derives
 * no-progress from observable state, not model self-report (design doc budgets
 * section). Deliberately EXCLUDES continuation-runtime-written fields
 * (updatedAt, generation, ledger timestamps, lastReason).
 */
export function progressFingerprint(mission: Mission): string {
	const parts: string[] = [
		`lifecycle=${mission.lifecycle}`,
		`decision=${mission.decisionId ?? ""}`,
		`regression=${mission.regressionContractId ?? ""}`,
		`proposal=${mission.proposalId ?? ""}`,
		`verifyVerdict=${verificationVerdict(mission.verification) ?? ""}`,
		`verifySummary=${mission.verification?.summary ?? ""}`,
		`reviewVerdict=${reviewVerdict(mission.review) ?? ""}`,
		`reviewSummary=${mission.review?.summary ?? ""}`,
		`reviewSourceFiles=${mission.review?.sourceFiles.join(",") ?? ""}`,
		`outcome=${mission.outcome?.summary ?? ""}`,
		`phases=${(mission.phases ?? []).map(p => `${p.id}:${p.status}`).join(",")}`,
		`tasks=${mission.tasks.map(t => `${t.id}:${t.status}`).join(",")}`,
		`criteria=${mission.acceptanceCriteria.map(c => `${c.id}:${c.satisfied ? 1 : 0}`).join(",")}`,
		`evidence=${mission.evidenceRefs.length}`,
		`tokensUsed=${mission.budget.tokensUsed}`,
	];
	return parts.join("|");
}
