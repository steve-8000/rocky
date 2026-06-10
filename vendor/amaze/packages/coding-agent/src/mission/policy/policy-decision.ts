import type { MissionIntent } from "./intent";
import type { PolicyRiskLevel } from "./risk";

/**
 * Coarse classes of tools the policy engine allows or denies. These are
 * capability buckets rather than concrete tool ids; the tool gateway (Lane H)
 * maps registered tools onto these classes when enforcing a decision.
 */
export const TOOL_CLASSES = [
	"read", // read-only filesystem / inspection
	"web", // web fetch / search
	"codebase", // repo analysis (grep, ast, symbol search)
	"memory", // memory read/write
	"mutation", // file edits / writes / shell that changes state
	"shell", // arbitrary shell execution
	"external", // calls to external systems (deploy, network side effects)
	"subagent", // spawning sub-agents / sub-missions
] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

/**
 * The per-mission context-window budget the policy derives. Distinct from the
 * core {@link import("../core/mission-budget").MissionContextBudget} (which
 * tracks live token occupancy); this is the policy's *advice* on how much of
 * each context source a mission of this risk/shape should pull in.
 */
export interface MissionContextBudget {
	/** Soft cap on input tokens assembled into a single model turn. */
	maxInputTokens: number;
	/** Max memory items to retrieve into context. */
	maxMemoryItems: number;
	/** Max files to read into context up front. */
	maxFiles: number;
	/** Max web sources to pull in. */
	maxWebSources: number;
}

/**
 * The decision produced by the {@link import("./classifier").MissionClassifier}
 * for a mission. Pure data: it describes *what capabilities and ceremony a
 * mission of this shape requires*, leaving enforcement to the runtime + gateway.
 *
 * Shape per workplan §8.
 */
export interface MissionPolicyDecision {
	/** Requires a web/search pass. */
	requiresWeb: boolean;
	/** Requires codebase analysis. */
	requiresCodebase: boolean;
	/** Requires memory retrieval/curation. */
	requiresMemory: boolean;
	/** Requires a dedicated research phase (multi-lane). */
	requiresResearch: boolean;
	/** Requires an adversarial critic gate before/after execution. */
	requiresCritic: boolean;
	/** Requires acceptance verification before completion. */
	requiresVerifier: boolean;
	/** Requires spawning one or more subagents. */
	requiresSubagent: boolean;
	/** Requires explicit human approval before acting. */
	requiresApproval: boolean;
	/** Tool classes the mission is permitted to use. */
	allowedToolClasses: ToolClass[];
	/** Tool classes explicitly denied (takes precedence over allowed). */
	deniedToolClasses: ToolClass[];
	/** Effective risk level (policy taxonomy, may be `critical`). */
	riskLevel: PolicyRiskLevel;
	/** Classified mission intent taxonomy. */
	intent: MissionIntent;
	/** Derived context-window budget. */
	contextBudget: MissionContextBudget;
	/** Human-readable explanation of why this decision was reached. */
	rationale: string;
}
