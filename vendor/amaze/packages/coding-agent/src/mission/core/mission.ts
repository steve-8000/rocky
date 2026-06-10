import type { RiskLevel } from "../../research/types";
import type { MissionIntent } from "../policy/intent";
import type { AcceptanceCriterion } from "./acceptance-criteria";
import type { MissionBudget, MissionContextBudget } from "./mission-budget";
import type { MissionInput, MissionMode } from "./mission-input";
import type { MissionOutcome } from "./mission-outcome";
import type { MissionPhase } from "./mission-phase";
import type { MissionScopeGuard } from "./mission-scope";
import type { MissionTask, MissionTaskStatus } from "./mission-task";

/**
 * The full lifecycle a mission progresses through. Ordered roughly by the
 * canonical happy path, with several terminal/exception states.
 */
export const MISSION_LIFECYCLE_STATES = [
	"created",
	"classified",
	"planning",
	"researching",
	"critiquing",
	"contracting",
	"executing",
	"verifying",
	"completed",
	"blocked",
	"cancelled",
	"rolled_back",
] as const;

/**
 * Discriminated lifecycle state for a {@link Mission}.
 */
export type MissionLifecycleState = (typeof MISSION_LIFECYCLE_STATES)[number];

/**
 * Semantic edge kinds between planned steps. `depends-on` is the direct
 * replacement for the legacy {@link MissionPlanStep.dependsOn} ordering-only field.
 */
export const MISSION_PLAN_STEP_EDGE_KINDS = [
	"depends-on",
	"produces",
	"must-precede",
	"behavior-change",
	"needs-decision",
] as const;

/** Discriminated kind for a {@link MissionPlanStepEdge}. */
export type MissionPlanStepEdgeKind = (typeof MISSION_PLAN_STEP_EDGE_KINDS)[number];

/** A typed invariant edge from one plan step to another. */
export interface MissionPlanStepEdge {
	target: string;
	kind: MissionPlanStepEdgeKind;
	invariant?: string;
}

/**
 * A single planned step. Kept intentionally minimal at the core level; richer
 * planning structures live in higher layers.
 */
export interface MissionPlanStep {
	id: string;
	description: string;
	/** @deprecated use `edges` with kind:"depends-on". Kept for backward compatibility. */
	dependsOn?: string[];
	edges?: MissionPlanStepEdge[];
}

/** Normalize legacy and typed plan-step edges into one ordered edge list. */
export function normalizePlanStepEdges(step: MissionPlanStep): MissionPlanStepEdge[] {
	const out: MissionPlanStepEdge[] = step.edges ? [...step.edges] : [];
	if (step.dependsOn) {
		for (const target of step.dependsOn) {
			if (!out.some(e => e.target === target && e.kind === "depends-on")) {
				out.push({ target, kind: "depends-on" });
			}
		}
	}
	return out;
}

/**
 * A mission plan: the ordered intent the runtime will execute.
 */
export interface MissionPlan {
	steps: MissionPlanStep[];
	rationale?: string;
	revision?: number;
}

/**
 * Re-exported from {@link ./mission-task}. The canonical task type now lives there
 * (workplan §10) as a superset of the original minimal record; this re-export keeps
 * existing `from "./mission"` / `mission/core` imports stable.
 */
export type { MissionTask, MissionTaskStatus };

/**
 * Verification outcome attached to a mission.
 */
export interface MissionVerification {
	status: "pass" | "fail" | "uncertain" | "force";
	verdict?: "pass" | "fail" | "pending";
	summary: string;
	failedCount?: number;
	uncertainCount?: number;
}

/**
 * Whole-source review verdict attached to a mission. Markdown files are tracked
 * only as exclusions and never satisfy source-review coverage.
 */
export interface MissionReview {
	status: "pass" | "fail" | "uncertain";
	verdict: "pass" | "fail" | "pending";
	summary: string;
	failedCount: number;
	uncertainCount: number;
	sourceFiles: string[];
	excludedMarkdownFiles: string[];
	createdAt: number;
	reviewedAt: number;
}

/**
 * Rollback record attached to a mission.
 */
export interface MissionRollback {
	targetType: "decision" | "proposal" | "file";
	targetId: string;
	snapshotRef?: string;
	summary: string;
}

/**
 * The canonical Mission aggregate for the refactored mission core. This is the
 * forward-looking shape; see {@link ../core/compat} for mappings to/from the
 * existing {@link ../types.Mission} record.
 */
export interface Mission {
	id: string;
	title: string;
	objective: string;
	mode: MissionMode;
	lifecycle: MissionLifecycleState;
	riskLevel: RiskLevel;
	intent?: MissionIntent;
	projectId?: string;
	sessionId?: string;
	parentMissionId?: string;
	constraints: string[];
	acceptanceCriteria: AcceptanceCriterion[];
	designAnswers?: Record<string, string>;
	scopeGuard?: MissionScopeGuard;
	budget: MissionBudget;
	contextBudget: MissionContextBudget;
	contractRevision?: number;
	plan?: MissionPlan;
	phases?: MissionPhase[];
	tasks: MissionTask[];
	evidenceRefs: string[];
	decisionId?: string;
	regressionContractId?: string;
	proposalId?: string;
	verification?: MissionVerification;
	review?: MissionReview;
	rollback?: MissionRollback;
	outcome?: MissionOutcome;
	createdAt: number;
	updatedAt: number;
	/**
	 * Monotonically-increasing aggregate revision; bumped on every mutation across
	 * mission row + durable aggregate tables. Used for cross-session stale-cache
	 * detection.
	 */
	revision: number;
}

export type { MissionInput, MissionMode };
