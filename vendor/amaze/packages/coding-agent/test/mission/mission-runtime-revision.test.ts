import { afterEach, describe, expect, test } from "bun:test";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionStore } from "../../src/mission/store";

const stores: MissionStore[] = [];
const runtimes: MissionRuntimeImpl[] = [];

function createSharedRuntime(store = new MissionStore(":memory:")): {
	store: MissionStore;
	runtime: MissionRuntimeImpl;
} {
	if (!stores.includes(store)) stores.push(store);
	const runtime = new MissionRuntimeImpl({ store });
	runtimes.push(runtime);
	return { store, runtime };
}

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) store.close();
});

describe("MissionRuntime revision", () => {
	test("create starts at revision 0", async () => {
		const { runtime } = createSharedRuntime();
		const mission = await runtime.create({ title: "Revision start", objective: "Create mission" });

		expect(mission.revision).toBe(0);
	});

	test("attachProposal bumps revision by exactly 1", async () => {
		const { runtime } = createSharedRuntime();
		const mission = await runtime.create({ title: "Proposal revision", objective: "Attach proposal" });
		const before = mission.revision;

		const updated = runtime.attachProposal(mission.id, { proposalId: "proposal-1" });

		expect(updated.revision).toBe(before + 1);
	});

	test("recordVerification bumps revision by exactly 1", async () => {
		const { runtime } = createSharedRuntime();
		const mission = await runtime.create({ title: "Verification revision", objective: "Record verification" });
		const before = mission.revision;

		const updated = runtime.recordVerification(mission.id, {
			status: "pass",
			verdict: "pass",
			summary: "verified",
			failedCount: 0,
			uncertainCount: 0,
		});

		expect(updated.revision).toBe(before + 1);
	});

	test("tryGet rehydrates when a sibling runtime mutates the mission", async () => {
		const store = new MissionStore(":memory:");
		const runtimeA = createSharedRuntime(store).runtime;
		const runtimeB = createSharedRuntime(store).runtime;
		const mission = await runtimeA.create({ title: "Sibling revision", objective: "Detect sibling mutation" });
		const cached = runtimeA.tryGet(mission.id);
		if (!cached) throw new Error("expected cached mission");

		runtimeB.attachProposal(mission.id, { proposalId: "proposal-from-b" });
		const refreshed = runtimeA.tryGet(mission.id);

		expect(refreshed).toBeDefined();
		expect(refreshed).not.toBe(cached);
		expect(refreshed?.proposalId).toBe("proposal-from-b");
		expect(refreshed?.revision).toBeGreaterThan(cached.revision);
	});

	test("pure task aggregate writes bump mission revision", async () => {
		const { store, runtime } = createSharedRuntime();
		const mission = await runtime.create({ title: "Task revision", objective: "Persist task" });
		const before = store.getMissionRevision(mission.id);

		store.saveTask({
			missionId: mission.id,
			id: "task-1",
			title: "Do the task",
			status: "pending",
		});

		expect(store.getMissionRevision(mission.id)).toBe((before ?? 0) + 1);
	});
});
