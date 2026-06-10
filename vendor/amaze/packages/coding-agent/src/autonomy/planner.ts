import type { Settings } from "../config/settings";
import type { LearningProposal } from "../learning";
import type { EvoMetricSignal, EvoStage, EvoTrace } from "./evo-trace";
import type { Objective } from "./types";

interface MetricRemediation {
	patch: Record<string, unknown>;
	reason: string;
	rollback: Record<string, unknown>;
}

/**
 * Built-in remediations keyed by the EXACT metric name registered in
 * `metrics/definitions.ts`. Each remediation's patch and rollback values MUST
 * validate against `config/settings-schema.ts`. The two invariants are enforced
 * by `test/autonomy/planner-correctness.test.ts`.
 */
const BUILTIN_REMEDIATIONS: Record<string, MetricRemediation> = {
	"goal.forceCompleteRate": {
		patch: { "goal.uncertainPolicy": "block-manual" },
		reason:
			"Tighten uncertain-policy so uncertain criteria surface before completion instead of being force-completed.",
		rollback: { "goal.uncertainPolicy": "allow" },
	},
	"verifier.bypassRate": {
		patch: { "task.yield.allowSchemaBypass": false },
		reason: "Reduce verifier bypasses by disabling schema bypass for task yield validation.",
		rollback: { "task.yield.allowSchemaBypass": true },
	},
};

/** Read-only settings surface the planner uses for no-op suppression. */
export type PlannerSettings = Pick<Settings, "get">;

export function planFromMetrics(
	objective: Objective,
	metrics: Record<string, number>,
	opts: { sessionId?: string; settings?: PlannerSettings } = {},
): { proposal: LearningProposal | null; trace: EvoTrace } {
	const metricSignals: EvoMetricSignal[] = objective.metricTargets.map(t => {
		const current = metrics[t.metric];
		const mismatch = t.direction === "down" ? current > t.target : current < t.target;
		return {
			metric: t.metric,
			current: Number.isFinite(current) ? current : 0,
			target: t.target,
			direction: t.direction,
			mismatch,
		};
	});

	const mismatch = objective.metricTargets.find(target => {
		const value = metrics[target.metric];
		if (value === undefined || !Number.isFinite(value)) return false;
		return target.direction === "down" ? value > target.target : value < target.target;
	});

	const makeTrace = (stage: EvoStage, proposal: LearningProposal | null, nextActions: string[]): EvoTrace => ({
		objectiveId: objective.id,
		stage,
		metricSignals,
		proposalId: proposal?.id,
		proposalType: proposal?.type,
		gate: proposal?.gate,
		guardrailBlocks: [],
		nextActions,
	});

	if (!mismatch) return { proposal: null, trace: makeTrace("signal", null, ["no remediation needed"]) };

	const base = {
		id: `autonomy-${objective.id}-${mismatch.metric}-${Date.now()}`,
		createdAt: Date.now(),
		status: "pending" as const,
		gate: "human-required" as const,
		evidence: {
			sessionIds: opts.sessionId ? [opts.sessionId] : [],
			eventRefs: [],
			ruleFindings: [],
			sampleN: 1,
		},
		provenance: { source: "reflection" as const },
	};

	const remediation = BUILTIN_REMEDIATIONS[mismatch.metric];
	if (remediation) {
		// No-op suppression: if current settings already match the patch, skip.
		if (opts.settings) {
			const stngs = opts.settings;
			const meaningful = Object.entries(remediation.patch).some(([key, value]) => stngs.get(key as any) !== value);
			if (!meaningful) return { proposal: null, trace: makeTrace("signal", null, ["no remediation needed"]) };
		}
		const proposal: LearningProposal = {
			...base,
			provenance: { ...base.provenance, objectiveId: objective.id } as LearningProposal["provenance"],
			type: "settings",
			patch: remediation.patch,
			reason: `${remediation.reason} Objective: ${objective.title}. Current ${mismatch.metric}=${metrics[mismatch.metric]}, target ${mismatch.direction} ${mismatch.target}.`,
			rollback: remediation.rollback,
		};
		return { proposal, trace: makeTrace("proposal", proposal, ["preview the proposal", "approve when ready"]) };
	}

	const proposal: LearningProposal = {
		...base,
		provenance: { ...base.provenance, objectiveId: objective.id } as LearningProposal["provenance"],
		type: "rule",
		ruleMarkdown: `# ${objective.title}\n\nInvestigate metric \`${mismatch.metric}\` and propose a bounded remediation because current value ${metrics[mismatch.metric]} is not ${mismatch.direction} target ${mismatch.target}.`,
		replaySessions: opts.sessionId ? [opts.sessionId] : [],
		expectedImpact: `Move ${mismatch.metric} ${mismatch.direction} toward ${mismatch.target}.`,
	};
	return { proposal, trace: makeTrace("proposal", proposal, ["preview the proposal", "approve when ready"]) };
}

/** Internal accessor used by correctness tests. */
export const __BUILTIN_REMEDIATIONS = BUILTIN_REMEDIATIONS;
