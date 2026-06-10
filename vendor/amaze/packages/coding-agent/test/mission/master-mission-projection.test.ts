import { afterEach, describe, expect, test } from "bun:test";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { projectMissionToTodoPhases } from "../../src/mission/core/mission-todo-projection";
import { MissionStore } from "../../src/mission/store";

const stores: MissionStore[] = [];

afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});

function createStore(): MissionStore {
	const store = new MissionStore(":memory:");
	stores.push(store);
	return store;
}

function syntheticStatus(mission: NonNullable<ReturnType<MissionRuntimeImpl["tryGet"]>>, phaseName: string) {
	return projectMissionToTodoPhases(mission).find(p => p.name === phaseName)?.tasks[0]?.status;
}

describe("master mission todo projection", () => {
	test("master mission shape: terminal lifecycle + recorded pointers + pass verification → all synthetic items completed", async () => {
		const store = createStore();
		const runtime = new MissionRuntimeImpl({ store });
		const mission = await runtime.create({
			title: "Master mission",
			objective: "Clear the master mission projection",
			intent: "architecture_change",
		});

		store.updateMission(mission.id, { decisionId: "decision-master", regressionContractId: "regression-master" });
		store.recordVerification({
			missionId: mission.id,
			status: "pass",
			failedCount: 0,
			uncertainCount: 0,
			summary: "ok",
		});

		const runtime2 = new MissionRuntimeImpl({ store });
		expect(runtime2.tryGet(mission.id)?.verification?.verdict).toBe("pass");

		store.updateMission(mission.id, { state: "completed", lifecycle: "completed" });
		const runtime3 = new MissionRuntimeImpl({ store });
		const hydrated = runtime3.tryGet(mission.id);

		expect(hydrated?.decisionId).toBe("decision-master");
		expect(hydrated?.regressionContractId).toBe("regression-master");
		expect(hydrated?.verification?.verdict).toBe("pass");
		expect(hydrated?.lifecycle).toBe("completed");

		expect(syntheticStatus(hydrated!, "Decision")).toBe("completed");
		expect(syntheticStatus(hydrated!, "Regression")).toBe("completed");
		expect(syntheticStatus(hydrated!, "Verification")).toBe("completed");
	});

	test("master mission shape without recorded pointers still projects completed (terminal fallback path)", async () => {
		const store = createStore();
		const runtime = new MissionRuntimeImpl({ store });
		const mission = await runtime.create({
			title: "Master mission",
			objective: "Clear the master mission projection",
			intent: "architecture_change",
		});

		store.updateMission(mission.id, { state: "completed", lifecycle: "completed" });
		const runtime2 = new MissionRuntimeImpl({ store });
		const hydrated = runtime2.tryGet(mission.id);

		expect(hydrated?.decisionId).toBeUndefined();
		expect(hydrated?.regressionContractId).toBeUndefined();
		expect(hydrated?.verification).toBeUndefined();
		expect(hydrated?.lifecycle).toBe("completed");
		expect(syntheticStatus(hydrated!, "Decision")).toBe("completed");
		expect(syntheticStatus(hydrated!, "Regression")).toBe("completed");
		expect(syntheticStatus(hydrated!, "Verification")).toBe("completed");
	});

	test("cancelled mission with recorded pointers — Decision/Regression completed (pointers win), Verification abandoned (terminal)", async () => {
		const store = createStore();
		const runtime = new MissionRuntimeImpl({ store });
		const mission = await runtime.create({
			title: "Master mission",
			objective: "Clear the master mission projection",
			intent: "architecture_change",
		});

		store.updateMission(mission.id, {
			state: "cancelled",
			lifecycle: "cancelled",
			decisionId: "decision-master",
			regressionContractId: "regression-master",
		});
		const runtime2 = new MissionRuntimeImpl({ store });
		const hydrated = runtime2.tryGet(mission.id);

		expect(hydrated?.decisionId).toBe("decision-master");
		expect(hydrated?.regressionContractId).toBe("regression-master");
		expect(hydrated?.verification).toBeUndefined();
		expect(hydrated?.lifecycle).toBe("cancelled");
		expect(syntheticStatus(hydrated!, "Decision")).toBe("completed");
		expect(syntheticStatus(hydrated!, "Regression")).toBe("completed");
		expect(syntheticStatus(hydrated!, "Verification")).toBe("abandoned");
	});
});
