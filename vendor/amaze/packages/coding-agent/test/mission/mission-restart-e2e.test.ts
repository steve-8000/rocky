import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionStore } from "../../src/mission/store";

const stores: MissionStore[] = [];
const runtimes: MissionRuntimeImpl[] = [];
const tempDirs: string[] = [];

function createStore(dbPath: string): MissionStore {
	const store = new MissionStore(dbPath);
	stores.push(store);
	return store;
}

function createRuntime(store: MissionStore): MissionRuntimeImpl {
	const runtime = new MissionRuntimeImpl({ store });
	runtimes.push(runtime);
	return runtime;
}

function tempDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mre2e-"));
	tempDirs.push(dir);
	return path.join(dir, "autonomy.db");
}

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// already closed by the owning runtime or the test body
		}
	}
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Mission restart/replay e2e", () => {
	test("durable aggregate (tasks, plan, criteria, budget, scope, proposal) survives a fresh runtime", async () => {
		const dbPath = tempDb();
		const store = createStore(dbPath);
		const runtime = createRuntime(store);
		const mission = await runtime.create({
			title: "Restart Replay",
			objective: "Persist everything",
			mode: "interactive",
			intent: "architecture_change",
			acceptanceCriteria: [{ id: "c1", description: "tests pass", satisfied: false }],
			scopeGuard: { allowedPaths: ["src/**"], deniedPaths: ["dist/**"] },
			budget: { tokenBudget: 1000, tokensUsed: 250 },
			contextBudget: { maxContextTokens: 200_000, contextTokensUsed: 50_000 },
		});

		store.saveAcceptanceCriteria(mission.id, [{ id: "c1", description: "tests pass", satisfied: false }]);
		store.saveScopeGuard(mission.id, { allowedPaths: ["src/**"], deniedPaths: ["dist/**"] });
		store.saveBudget(
			mission.id,
			{ tokenBudget: 1000, tokensUsed: 250 },
			{ maxContextTokens: 200_000, contextTokensUsed: 50_000 },
		);
		store.savePlan(mission.id, {
			steps: [
				{ id: "s1", description: "first" },
				{ id: "s2", description: "second", edges: [{ target: "s1", kind: "depends-on" }] },
			],
			rationale: "phase a",
			revision: 1,
		});
		store.saveTask({ id: "t1", missionId: mission.id, title: "Plan", status: "completed", planStepId: "s1" });
		store.saveTask({ id: "t2", missionId: mission.id, title: "Execute", status: "running", planStepId: "s2" });
		const proposal = store.saveProposal({
			id: "prop-1",
			missionId: mission.id,
			artifactUri: "local://PLAN.md",
			contentHash: "abc123",
			status: "draft",
			summary: "v1 plan",
		});
		store.updateProposalStatus(proposal.id, "approved", "user");

		const expectedIds = { missionId: mission.id, proposalId: proposal.id };
		store.close();

		const store2 = createStore(dbPath);
		const runtime2 = createRuntime(store2);
		const hydrated = runtime2.tryGet(expectedIds.missionId);

		expect(hydrated).toBeDefined();
		expect(hydrated?.id).toBe(expectedIds.missionId);
		expect(hydrated?.acceptanceCriteria.map(c => c.id)).toEqual(["c1"]);
		expect(hydrated?.scopeGuard?.allowedPaths).toEqual(["src/**"]);
		expect(hydrated?.scopeGuard?.deniedPaths).toEqual(["dist/**"]);
		expect(hydrated?.budget.tokenBudget).toBe(1000);
		expect(hydrated?.budget.tokensUsed).toBe(250);
		expect(hydrated?.contextBudget.maxContextTokens).toBe(200_000);
		expect(hydrated?.contextBudget.contextTokensUsed).toBe(50_000);
		expect(hydrated?.plan?.steps.map(s => s.id)).toEqual(["s1", "s2"]);
		expect(hydrated?.plan?.steps[1]?.edges).toEqual([{ target: "s1", kind: "depends-on" }]);
		expect(hydrated?.tasks.map(t => t.id).sort()).toEqual(["t1", "t2"]);
		expect(store2.getLatestApprovedProposal(expectedIds.missionId)?.id).toBe(expectedIds.proposalId);
	});
});
