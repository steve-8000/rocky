import { describe, expect, it } from "bun:test";
import { __BUILTIN_REMEDIATIONS, planFromMetrics } from "../../src/autonomy/planner";
import type { Objective } from "../../src/autonomy/types";
import { Settings } from "../../src/config/settings";

function objectiveFor(metric: string): Objective {
	return {
		id: `obj-${metric}`,
		title: `Reduce ${metric}`,
		metricTargets: [{ metric, target: 0.01, direction: "down" }],
		budget: {},
		guardrails: { requireHumanForApply: true, maxAutoSubgoalsPerDay: 1, forbiddenScopes: [] },
		status: "active",
	};
}

describe("planFromMetrics built-in remediation proposals", () => {
	for (const [metric, remediation] of Object.entries(__BUILTIN_REMEDIATIONS)) {
		it(`emits and suppresses the ${metric} settings remediation`, () => {
			const { proposal, trace } = planFromMetrics(objectiveFor(metric), { [metric]: 0.05 });

			expect(proposal).not.toBeNull();
			expect(proposal?.type).toBe("settings");
			expect(trace.stage).toBe("proposal");
			expect(trace.metricSignals[0]?.mismatch).toBe(true);
			if (proposal?.type !== "settings") throw new Error(`${metric} did not emit a settings proposal`);
			expect(proposal.patch).toEqual(remediation.patch);

			const settings = Settings.isolated(remediation.patch);
			const suppressed = planFromMetrics(objectiveFor(metric), { [metric]: 0.05 }, { settings });

			expect(suppressed.proposal).toBeNull();
		});
	}
});
