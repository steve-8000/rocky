import type { RiskLevel } from "../../research/types";
import type { MissionIntent } from "../policy/intent";
import type { AcceptanceCriterion } from "./acceptance-criteria";
import type { MissionBudget, MissionContextBudget } from "./mission-budget";
import type { MissionScopeGuard } from "./mission-scope";

/**
 * Operating mode for a mission. Determines how aggressively the runtime acts
 * without human confirmation.
 */
export type MissionMode = "autonomous" | "interactive" | "dry-run" | "auto";

/**
 * The caller-supplied request used to create a new mission. Everything the
 * runtime can derive (id, lifecycle, timestamps, plan, tasks, outcome) is
 * intentionally omitted here.
 */
export interface MissionInput {
	/** Short human-readable title. */
	title: string;
	id?: string;
	/** The objective the mission is trying to achieve. */
	objective: string;
	/** Operating mode; defaults are resolved by the runtime when omitted. */
	mode?: MissionMode;
	/** Caller-asserted risk level, if known ahead of classification. */
	riskLevel?: RiskLevel;
	intent?: MissionIntent;
	/** Owning project, if any. */
	projectId?: string;
	/** Originating session, if any. */
	sessionId?: string;
	/** Parent mission when this is a sub-mission. */
	parentMissionId?: string;
	/** Hard constraints the mission must respect. */
	constraints?: string[];
	/** Conditions that define success. */
	acceptanceCriteria?: AcceptanceCriterion[];
	/** Scope guard limiting what may be touched. */
	scopeGuard?: MissionScopeGuard;
	/** Token/cost budget. */
	budget?: MissionBudget;
	/** Context-window budget. */
	contextBudget?: MissionContextBudget;
}
