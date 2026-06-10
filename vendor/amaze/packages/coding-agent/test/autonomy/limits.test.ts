import { describe, expect, it } from "bun:test";
import { DEFAULT_AUTONOMY_FORBIDDEN_SCOPES } from "../../src/autonomy/guardrails";
import { shouldEmitProposal } from "../../src/autonomy/limits";
import type { Objective } from "../../src/autonomy/types";
import type { LearningProposal } from "../../src/learning";

const objective: Objective = {
	id: "obj-1",
	title: "Stay in budget",
	metricTargets: [{ metric: "force_complete_rate", target: 0.01, direction: "down" }],
	budget: { tokens: 100, usd: 1 },
	guardrails: {
		requireHumanForApply: true,
		maxAutoSubgoalsPerDay: 1,
		forbiddenScopes: ["packages/coding-agent/src/learning/**"],
	},
	status: "active",
};

const candidate: LearningProposal = {
	id: "p1",
	createdAt: 1,
	status: "pending",
	gate: "human-required",
	evidence: { sessionIds: [], eventRefs: [], ruleFindings: [], sampleN: 1 },
	provenance: { source: "reflection" },
	type: "settings",
	patch: { "goal.uncertainPolicy": "ask" },
	reason: "test",
	rollback: { "goal.uncertainPolicy": "complete" },
};

describe("shouldEmitProposal", () => {
	it("denies when the daily subgoal count is exhausted", () => {
		expect(shouldEmitProposal(objective, candidate, { todayCount: 1, usedTokens: 0 }).allow).toBe(false);
	});

	it("denies when token or usd budget is exhausted", () => {
		expect(shouldEmitProposal(objective, candidate, { todayCount: 0, usedTokens: 100 }).allow).toBe(false);
		expect(shouldEmitProposal(objective, candidate, { todayCount: 0, usedTokens: 0, usedUsdCents: 100 }).allow).toBe(
			false,
		);
	});

	it("denies when a settings patch targets a forbidden path", () => {
		const forbidden = { ...candidate, patch: { "packages/coding-agent/src/learning/store.ts": true } };
		expect(
			shouldEmitProposal(
				objective,
				forbidden,
				{ todayCount: 0, usedTokens: 0 },
				{
					forbiddenScopes: ["settings:packages/coding-agent/src/learning/store.ts"],
				},
			).allow,
		).toBe(false);
	});

	it("denies a settings proposal under default guardrails because .amaze/settings.json is forbidden", () => {
		const guardedObjective: Objective = {
			...objective,
			guardrails: {
				...objective.guardrails,
				forbiddenScopes: [...DEFAULT_AUTONOMY_FORBIDDEN_SCOPES],
			},
		};
		const settingsProposal: LearningProposal = {
			...candidate,
			patch: { "goal.uncertainPolicy": "block-manual" },
			rollback: { "goal.uncertainPolicy": "ask" },
		};

		const result = shouldEmitProposal(guardedObjective, settingsProposal, { todayCount: 0, usedTokens: 0 });

		expect(result.allow).toBe(false);
		expect(result.reason).toContain(".amaze/settings.json");
	});

	it("denies a rule proposal when .amaze/rules/** is forbidden", () => {
		const guardedObjective: Objective = {
			...objective,
			guardrails: {
				...objective.guardrails,
				forbiddenScopes: [".amaze/rules/**"],
			},
		};
		const ruleProposal: LearningProposal = {
			id: "p-rule",
			createdAt: 1,
			status: "pending",
			gate: "human-required",
			evidence: { sessionIds: [], eventRefs: [], ruleFindings: [], sampleN: 0 },
			provenance: { source: "reflection" },
			type: "rule",
			ruleMarkdown: "# x",
			replaySessions: [],
			expectedImpact: "x",
		};

		const result = shouldEmitProposal(guardedObjective, ruleProposal, { todayCount: 0, usedTokens: 0 });

		expect(result.allow).toBe(false);
		expect(result.reason).toContain(".amaze/rules/**");
	});

	it("denies a skill proposal whose target file path matches the forbidden scope", () => {
		const guardedObjective: Objective = {
			...objective,
			guardrails: {
				...objective.guardrails,
				forbiddenScopes: [".amaze/skills/foo/SKILL.md"],
			},
		};
		const skillProposal: LearningProposal = {
			id: "p-skill",
			createdAt: 1,
			status: "pending",
			gate: "human-required",
			evidence: { sessionIds: [], eventRefs: [], ruleFindings: [], sampleN: 0 },
			provenance: { source: "reflection" },
			type: "skill",
			name: "foo",
			sourceMemoryIds: [],
			bodyMarkdown: "x",
		};

		const result = shouldEmitProposal(guardedObjective, skillProposal, { todayCount: 0, usedTokens: 0 });

		expect(result.allow).toBe(false);
	});

	it("denies a skill proposal when the broader .amaze/skills/** scope is forbidden", () => {
		const guardedObjective: Objective = {
			...objective,
			guardrails: {
				...objective.guardrails,
				forbiddenScopes: [".amaze/skills/**"],
			},
		};
		const skillProposal: LearningProposal = {
			id: "p-skill",
			createdAt: 1,
			status: "pending",
			gate: "human-required",
			evidence: { sessionIds: [], eventRefs: [], ruleFindings: [], sampleN: 0 },
			provenance: { source: "reflection" },
			type: "skill",
			name: "foo",
			sourceMemoryIds: [],
			bodyMarkdown: "x",
		};

		const result = shouldEmitProposal(guardedObjective, skillProposal, { todayCount: 0, usedTokens: 0 });

		expect(result.allow).toBe(false);
		expect(result.reason).toContain(".amaze/skills/");
	});

	it("allows candidates within limits", () => {
		expect(shouldEmitProposal(objective, candidate, { todayCount: 0, usedTokens: 50, usedUsdCents: 50 })).toEqual({
			allow: true,
		});
	});
});
