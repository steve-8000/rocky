import { afterEach, describe, expect, test } from "bun:test";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionStore } from "../../src/mission/store";

const stores: MissionStore[] = [];

function fixture() {
	const store = new MissionStore(":memory:");
	stores.push(store);
	let active: string | undefined;
	const control = new MissionControlRuntime({
		store,
		getActiveMissionId: () => active,
		setActiveMissionId: id => {
			active = id;
		},
	});
	return {
		store,
		control,
		set: (id: string | undefined) => {
			active = id;
		},
		get: () => active,
	};
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("terminal mission active pointer detach", () => {
	test("non-terminal mission is returned by getActiveMission", async () => {
		const { control, get } = fixture();
		const mission = await control.createMission({
			title: "Active mission",
			objective: "Keep working",
			mode: "interactive",
			intent: "code_change",
		});

		expect(mission.lifecycle).toBe("executing");
		expect(control.getActiveMission()?.id).toBe(mission.id);
		expect(get()).toBe(mission.id);
	});

	test("terminal mission is detached on getActiveMission", async () => {
		const { control, set, get } = fixture();
		const mission = await control.createMission({
			title: "Completable mission",
			objective: "Finish work",
			mode: "interactive",
			intent: "code_change",
		});
		control.recordActiveVerification({ status: "pass", verdict: "pass", summary: "ok" });
		const completed = await control.completeActiveMission({ status: "success", summary: "done" });

		expect(completed?.lifecycle).toBe("completed");
		expect(control.getActiveMission()).toBeUndefined();
		set(mission.id);
		expect(control.getActiveMission()).toBeUndefined();
		expect(get()).toBeUndefined();
	});

	test("cancelled mission is detached on getActiveMission", async () => {
		const { control, set, get } = fixture();
		const mission = await control.createMission({
			title: "Cancellable mission",
			objective: "Stop work",
			mode: "interactive",
			intent: "code_change",
		});
		const cancelled = await control.cancelActiveMission("operator changed mind");

		expect(cancelled?.lifecycle).toBe("cancelled");
		set(mission.id);
		expect(control.getActiveMission()).toBeUndefined();
		expect(get()).toBeUndefined();
	});

	test("getActiveMission returns undefined when no active id without touching the runtime", () => {
		const { control, get } = fixture();

		expect(control.getActiveMission()).toBeUndefined();
		expect(get()).toBeUndefined();
	});
});
