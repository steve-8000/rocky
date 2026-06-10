import { afterEach, describe, expect, test } from "bun:test";
import type { AcceptanceCriterion } from "../../src/mission/core/acceptance-criteria";
import type { MissionPlan } from "../../src/mission/core/mission";
import type { MissionBudget, MissionContextBudget } from "../../src/mission/core/mission-budget";
import type { MissionScopeGuard } from "../../src/mission/core/mission-scope";
import type { MissionTask } from "../../src/mission/core/mission-task";
import { MissionStore } from "../../src/mission/store";
import type { NewResearchCampaign } from "../../src/mission/types";

const stores: MissionStore[] = [];

function createStore(): MissionStore {
	const store = new MissionStore(":memory:");
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function newMission(overrides: Partial<NewResearchCampaign> = {}): NewResearchCampaign {
	return {
		title: "P2 Aggregate Mission",
		objectiveId: null,
		briefId: null,
		decisionId: null,
		riskLevel: "medium",
		state: "drafting",
		confidence: null,
		snapshotRef: null,
		...overrides,
	};
}

describe("P2 mission durable aggregate", () => {
	test("tasks roundtrip including JSON-shaped fields", () => {
		const store = createStore();
		const mission = store.createMission(newMission());
		const task: MissionTask & { missionId: string } = {
			id: "task-1",
			missionId: mission.id,
			title: "Plan",
			objective: "Decide schema",
			status: "pending",
			assignedAgent: "explore",
			scope: { include: ["src/**"], exclude: ["dist/**"] },
			successCriteria: ["check passes"],
			escalationCriteria: ["budget exhausted"],
			allowedTools: ["read"],
			deniedTools: ["bash"],
			evidenceRefs: ["local://plan.md"],
			output: "ok",
			planStepId: "step-1",
		};
		store.saveTask(task);
		const [loaded] = store.listTasks(mission.id);
		expect(loaded).toBeDefined();
		expect(loaded.id).toBe("task-1");
		expect(loaded.scope).toEqual({ include: ["src/**"], exclude: ["dist/**"] });
		expect(loaded.allowedTools).toEqual(["read"]);
		expect(loaded.evidenceRefs).toEqual(["local://plan.md"]);
		expect(loaded.output).toBe("ok");
		// upsert
		store.saveTask({ ...task, status: "completed", output: "done" });
		const [updated] = store.listTasks(mission.id);
		expect(updated.status).toBe("completed");
		expect(updated.output).toBe("done");
	});

	test("plan + steps roundtrip and full-replace", () => {
		const store = createStore();
		const mission = store.createMission(newMission());
		const plan: MissionPlan = {
			rationale: "v1",
			revision: 1,
			steps: [
				{ id: "s1", description: "first" },
				{ id: "s2", description: "second", edges: [{ target: "s1", kind: "depends-on" }] },
			],
		};
		store.savePlan(mission.id, plan);
		const loaded = store.getPlan(mission.id);
		expect(loaded?.rationale).toBe("v1");
		expect(loaded?.steps.map(s => s.id)).toEqual(["s1", "s2"]);
		expect(loaded?.steps[1].edges).toEqual([{ target: "s1", kind: "depends-on" }]);
		// replace
		store.savePlan(mission.id, { steps: [{ id: "s3", description: "only" }], rationale: "v2", revision: 2 });
		const replaced = store.getPlan(mission.id);
		expect(replaced?.steps.map(s => s.id)).toEqual(["s3"]);
		expect(replaced?.revision).toBe(2);
	});

	test("acceptance criteria roundtrip preserves order and satisfied bit", () => {
		const store = createStore();
		const mission = store.createMission(newMission());
		const criteria: AcceptanceCriterion[] = [
			{ id: "c1", description: "tests pass", satisfied: false },
			{
				id: "c2",
				description: "lint clean",
				satisfied: true,
				verificationMethod: "biome",
				evidenceRefs: ["artifact://1"],
			},
		];
		store.saveAcceptanceCriteria(mission.id, criteria);
		const loaded = store.listAcceptanceCriteria(mission.id);
		expect(loaded.map(c => c.id)).toEqual(["c1", "c2"]);
		expect(loaded[0].satisfied).toBe(false);
		expect(loaded[1].satisfied).toBe(true);
		expect(loaded[1].verificationMethod).toBe("biome");
		expect(loaded[1].evidenceRefs).toEqual(["artifact://1"]);
	});

	test("budgets and context budgets roundtrip with optional fields", () => {
		const store = createStore();
		const mission = store.createMission(newMission());
		const budget: MissionBudget = {
			tokenBudget: 1000,
			tokensUsed: 250,
			timeBudgetMs: 60_000,
			taskBudget: 5,
			tasksUsed: 2,
		};
		const ctx: MissionContextBudget = {
			maxContextTokens: 200_000,
			contextTokensUsed: 50_000,
			compactionThreshold: 0.8,
		};
		store.saveBudget(mission.id, budget, ctx);
		const loaded = store.getBudget(mission.id);
		expect(loaded?.budget.tokenBudget).toBe(1000);
		expect(loaded?.budget.timeBudgetMs).toBe(60_000);
		expect(loaded?.budget.taskBudget).toBe(5);
		expect(loaded?.contextBudget.maxContextTokens).toBe(200_000);
		expect(loaded?.contextBudget.compactionThreshold).toBe(0.8);
	});

	test("scope guard roundtrip preserves tools and notes", () => {
		const store = createStore();
		const mission = store.createMission(newMission());
		const guard: MissionScopeGuard = {
			allowedPaths: ["src/**"],
			deniedPaths: ["**/*.snap"],
			allowedTools: ["read", "search"],
			allowSubMissions: true,
			notes: "explore only",
		};
		store.saveScopeGuard(mission.id, guard);
		const loaded = store.getScopeGuard(mission.id);
		expect(loaded?.allowedPaths).toEqual(["src/**"]);
		expect(loaded?.deniedPaths).toEqual(["**/*.snap"]);
		expect(loaded?.allowedTools).toEqual(["read", "search"]);
		expect(loaded?.allowSubMissions).toBe(true);
		expect(loaded?.notes).toBe("explore only");
	});

	test("proposal lifecycle: draft -> approved -> applied -> rolled_back", () => {
		const store = createStore();
		const mission = store.createMission(newMission());
		const draft = store.saveProposal({
			missionId: mission.id,
			artifactUri: "local://plan.md",
			contentHash: "abc123",
			summary: "v1 plan",
		});
		expect(draft.status).toBe("draft");
		expect(draft.approvedAt).toBeNull();

		const approved = store.updateProposalStatus(draft.id, "approved", "user");
		expect(approved.status).toBe("approved");
		expect(approved.approvedBy).toBe("user");
		expect(approved.approvedAt).toBeNumber();

		const latest = store.getLatestApprovedProposal(mission.id);
		expect(latest?.id).toBe(draft.id);

		const applied = store.updateProposalStatus(draft.id, "applied");
		expect(applied.status).toBe("applied");
		// approval timestamp/author preserved
		expect(applied.approvedBy).toBe("user");
		expect(applied.approvedAt).toBe(approved.approvedAt);

		const rolled = store.updateProposalStatus(draft.id, "rolled_back");
		expect(rolled.status).toBe("rolled_back");

		expect(store.listProposals(mission.id)).toHaveLength(1);
	});

	test("invalid proposal status throws", () => {
		const store = createStore();
		const mission = store.createMission(newMission());
		expect(() =>
			store.saveProposal({
				missionId: mission.id,
				artifactUri: "local://x.md",
				contentHash: "h",
				status: "bogus" as never,
			}),
		).toThrow(/Invalid mission proposal status/);
	});

	test("aggregate APIs reject unknown mission ids", () => {
		const store = createStore();
		expect(() => store.saveTask({ id: "x", missionId: "missing", title: "t", status: "pending" })).toThrow(
			/Mission not found/,
		);
		expect(() => store.savePlan("missing", { steps: [] })).toThrow(/Mission not found/);
		expect(() => store.saveAcceptanceCriteria("missing", [])).toThrow(/Mission not found/);
		expect(() =>
			store.saveBudget("missing", { tokenBudget: 1, tokensUsed: 0 }, { maxContextTokens: 1, contextTokensUsed: 0 }),
		).toThrow(/Mission not found/);
		expect(() => store.saveScopeGuard("missing", { allowedPaths: [], deniedPaths: [] })).toThrow(/Mission not found/);
		expect(() => store.saveProposal({ missionId: "missing", artifactUri: "u", contentHash: "h" })).toThrow(
			/Mission not found/,
		);
	});
});
