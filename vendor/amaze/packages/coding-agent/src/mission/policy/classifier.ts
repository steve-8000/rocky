import type { Mission } from "../core/mission";
import type { MissionInput } from "../core/mission-input";
import { deriveContextBudget } from "./context-budget";
import { inferIntent } from "./intent";
import type { MissionPolicyDecision, ToolClass } from "./policy-decision";
import {
	computeRiskLevel,
	impliesCriticalAction,
	impliesMutation,
	type MissionRiskSignals,
	type PolicyRiskLevel,
	riskAtLeast,
	riskSignalsFromInput,
	riskSignalsFromMission,
} from "./risk";

// --- Intent signal vocabulary ---------------------------------------------

const WEB_SIGNALS = [
	"latest",
	"current",
	"today",
	"news",
	"recent",
	"up to date",
	"up-to-date",
	"search the web",
	"online",
	"docs for",
	"version of",
	"changelog",
];
const CODEBASE_SIGNALS = [
	"this repo",
	"this codebase",
	"the code",
	"in the project",
	"analyze",
	"understand",
	"where is",
	"how does",
	"trace",
	"find the",
	"explain the",
	"audit",
	"review",
];
const RESEARCH_SIGNALS = ["research", "investigate", "compare", "evaluate options", "trade-off", "tradeoff", "survey"];
const LONG_TASK_SIGNALS = [
	"end to end",
	"end-to-end",
	"all night",
	"long task",
	"epic",
	"multi-step",
	"multi step",
	"over several",
	"entire",
	"whole system",
];

function anyMatch(text: string, signals: string[]): boolean {
	return signals.some(s => text.includes(s));
}

/**
 * Mission policy classifier. Maps a mission's shape onto a
 * {@link MissionPolicyDecision} using the default policy table (workplan §8).
 * Pure and deterministic — no IO, no model calls — so the decision is auditable
 * and cheaply testable. A richer LLM-backed classifier can later wrap this and
 * fall back to it.
 */
export class MissionClassifier {
	/** Classify a mission aggregate. */
	classify(mission: Pick<Mission, "title" | "objective" | "riskLevel" | "mode">): MissionPolicyDecision {
		return this.#decide(riskSignalsFromMission(mission));
	}

	/** Classify raw mission input (before an aggregate exists). */
	classifyInput(input: MissionInput): MissionPolicyDecision {
		return this.#decide(riskSignalsFromInput(input));
	}

	#decide(signals: MissionRiskSignals): MissionPolicyDecision {
		const text = signals.text;
		const intent = inferIntent({ objective: signals.objective });
		const riskLevel: PolicyRiskLevel = computeRiskLevel(signals);

		const mutation = impliesMutation(text);
		const critical = impliesCriticalAction(text);
		const longTask = anyMatch(text, LONG_TASK_SIGNALS);

		// --- Capability requirements (default policy table) ---
		const requiresWeb = anyMatch(text, WEB_SIGNALS);
		const requiresCodebase = anyMatch(text, CODEBASE_SIGNALS) || mutation;
		// research-heavy or explicitly long missions curate memory; trivial Q&A does not.
		const requiresResearch = anyMatch(text, RESEARCH_SIGNALS) || requiresWeb;
		const requiresMemory = requiresResearch || longTask;
		// high-risk design / critical work gets an adversarial critic.
		const requiresCritic = riskAtLeast(riskLevel, "high");
		// any state mutation must be verified before completion.
		const requiresVerifier = mutation || critical;
		// delete / deploy / external / irreversible actions need human approval.
		const requiresApproval = critical || riskLevel === "critical";
		// long / multi-step missions fan out to subagents.
		const requiresSubagent = longTask;

		// --- Tool classes ---
		const allowed = new Set<ToolClass>(["read"]);
		const denied = new Set<ToolClass>();

		if (requiresCodebase) allowed.add("codebase");
		if (requiresWeb) allowed.add("web");
		if (requiresMemory) allowed.add("memory");
		if (requiresSubagent) allowed.add("subagent");
		if (mutation || critical) {
			allowed.add("mutation");
			allowed.add("shell");
		} else {
			// pure Q&A / analysis: no write or shell capability.
			denied.add("mutation");
			denied.add("shell");
		}
		if (critical || riskLevel === "critical") {
			allowed.add("external");
		} else {
			denied.add("external");
		}

		const contextBudget = deriveContextBudget({
			riskLevel,
			requiresWeb,
			requiresCodebase,
			requiresMemory,
			requiresResearch,
		});

		const rationale = this.#rationale({
			riskLevel,
			mutation,
			critical,
			longTask,
			requiresWeb,
			requiresCodebase,
			requiresResearch,
			requiresCritic,
			requiresVerifier,
			requiresApproval,
		});

		return {
			requiresWeb,
			requiresCodebase,
			requiresMemory,
			requiresResearch,
			requiresCritic,
			requiresVerifier,
			requiresSubagent,
			requiresApproval,
			allowedToolClasses: [...allowed],
			deniedToolClasses: [...denied],
			riskLevel,
			intent,
			contextBudget,
			rationale,
		};
	}

	#rationale(d: {
		riskLevel: PolicyRiskLevel;
		mutation: boolean;
		critical: boolean;
		longTask: boolean;
		requiresWeb: boolean;
		requiresCodebase: boolean;
		requiresResearch: boolean;
		requiresCritic: boolean;
		requiresVerifier: boolean;
		requiresApproval: boolean;
	}): string {
		const parts: string[] = [`risk=${d.riskLevel}`];
		if (d.critical) parts.push("irreversible/external action detected");
		else if (d.mutation) parts.push("code/state mutation detected");
		else parts.push("read-only intent");
		if (d.requiresApproval) parts.push("human approval required");
		if (d.requiresCritic) parts.push("critic gate");
		if (d.requiresVerifier) parts.push("verifier gate");
		if (d.requiresResearch) parts.push("research pass");
		if (d.requiresWeb) parts.push("web sources");
		if (d.requiresCodebase) parts.push("codebase analysis");
		if (d.longTask) parts.push("long task → subagents + event log");
		return parts.join("; ");
	}
}

/** Shared default classifier instance. */
export const defaultMissionClassifier = new MissionClassifier();
