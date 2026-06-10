import type { SessionEvent } from "../observability";
import { registerMetric } from "./engine";
import type { MetricDefinition } from "./types";

type CountState = { numerator: number; denominator: number };
type TokenGoalState = { tokens: number; acceptedGoals: number };

const ratio = ({ numerator, denominator }: CountState): number => (denominator === 0 ? 0 : numerator / denominator);
const totalTokens = (usage: SessionEvent & { type: "turn.end" }) =>
	usage.usage.total ??
	(usage.usage.input ?? 0) + (usage.usage.output ?? 0) + (usage.usage.cacheRead ?? 0) + (usage.usage.cacheWrite ?? 0);

export const metricDefinitions: MetricDefinition[] = [
	{
		name: "goal.completion.passRate",
		eventTypes: ["goal.complete"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "goal.complete") return state;
			return { numerator: state.numerator + (event.verdict === "pass" ? 1 : 0), denominator: state.denominator + 1 };
		},
		finalize: ratio,
	},
	{
		name: "goal.forceCompleteRate",
		eventTypes: ["goal.complete"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "goal.complete") return state;
			return {
				numerator: state.numerator + (event.verdict === "force" ? 1 : 0),
				denominator: state.denominator + 1,
			};
		},
		finalize: ratio,
	},
	{
		name: "subagent.contractAdoption",
		eventTypes: ["subagent.start"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "subagent.start") return state;
			return { numerator: state.numerator + (event.hasContract ? 1 : 0), denominator: state.denominator + 1 };
		},
		finalize: ratio,
	},
	{
		name: "subagent.revisionSuccess",
		eventTypes: ["subagent.end"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "subagent.end" || event.revisions <= 0) return state;
			return { numerator: state.numerator + (event.verdict === "pass" ? 1 : 0), denominator: state.denominator + 1 };
		},
		finalize: ratio,
	},
	{
		name: "subagent.noYieldRate",
		eventTypes: ["subagent.end"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "subagent.end") return state;
			const reason = "reason" in event ? event.reason : undefined;
			return {
				numerator: state.numerator + (event.verdict === "fail" && reason === "no-yield" ? 1 : 0),
				denominator: state.denominator + 1,
			};
		},
		finalize: ratio,
	},
	{
		name: "memory.hitPrecision",
		eventTypes: ["memory.recall"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "memory.recall") return state;
			return { numerator: state.numerator + event.usedHits, denominator: state.denominator + event.hits };
		},
		finalize: ratio,
	},
	{
		name: "memory.staleRate",
		eventTypes: ["memory.write"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "memory.write") return state;
			return {
				numerator: state.numerator + (["superseded", "quarantined"].includes(event.status) ? 1 : 0),
				denominator: state.denominator + 1,
			};
		},
		finalize: ratio,
	},
	{
		name: "prompt.cacheChurn",
		eventTypes: ["prompt.cache"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "prompt.cache") return state;
			return {
				numerator: state.numerator + (event.missReason === "tail-change" ? 1 : 0),
				denominator: state.denominator + 1,
			};
		},
		finalize: ratio,
	},
	{
		// Fraction of cacheable input tokens served from cache: readTokens / (readTokens + writeTokens).
		// A healthy long session trends high (the STABLE_CORE prefix is re-read, not re-written). A
		// ratio stuck near 0 while STABLE_CORE is large is the signature of a volatile cached prefix —
		// e.g. the OAuth billing header (a per-request value) sitting ahead of the cache breakpoint
		// busting the whole prefix every turn. Use this to confirm/quantify that before attempting the
		// (auth-sensitive) fix of relocating the billing header out of the cached prefix.
		name: "prompt.cacheReadRatio",
		eventTypes: ["prompt.cache"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type !== "prompt.cache") return state;
			return {
				numerator: state.numerator + event.readTokens,
				denominator: state.denominator + event.readTokens + event.writeTokens,
			};
		},
		finalize: ratio,
	},
	{
		name: "cost.perAcceptedGoal",
		eventTypes: ["turn.end", "goal.complete"],
		initial: () => ({ tokens: 0, acceptedGoals: 0 }),
		reducer: (state: TokenGoalState, event) => {
			if (event.type === "turn.end") return { ...state, tokens: state.tokens + totalTokens(event) };
			if (event.type === "goal.complete" && event.verdict === "pass")
				return { ...state, acceptedGoals: state.acceptedGoals + 1 };
			return state;
		},
		finalize: state => (state.acceptedGoals === 0 ? 0 : state.tokens / state.acceptedGoals),
	},
	{
		name: "verifier.bypassRate",
		eventTypes: ["verifier.criterion", "goal.complete"],
		initial: () => ({ numerator: 0, denominator: 0 }),
		reducer: (state: CountState, event) => {
			if (event.type === "verifier.criterion" && event.status === "fail")
				return { ...state, denominator: state.denominator + 1 };
			if (event.type === "goal.complete" && event.verdict === "force")
				return { ...state, numerator: state.numerator + 1 };
			return state;
		},
		finalize: ratio,
	},
];

export function registerDefaultMetrics(): void {
	for (const definition of metricDefinitions) {
		registerMetric(definition);
	}
}

registerDefaultMetrics();
